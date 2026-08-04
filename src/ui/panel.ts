import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { runTurn, type UiPort } from "../agent/loop.ts";
import { estimateTokens } from "../agent/tokens.ts";
import { createSession, type Session } from "../state/session.ts";
import { listSessions, loadSession, newSessionFilePath, updateSessionTitle, deleteSession } from "../state/store.ts";
import { deleteCheckpointsFrom } from "../state/checkpoints.ts";
import { rewindToTurn } from "../state/rewind.ts";
import { getWorkspaceRoot, resolveWithinRoot } from "../tools/index.ts";
import { chat } from "../aicore/client.ts";
import { CLIENT_SECRET_KEY, readConfig } from "../aicore/config.ts";
import { normalizeAuthUrl, normalizeApiUrl } from "../aicore/urls.ts";
import { invalidateToken } from "../aicore/auth.ts";
import { classifyError } from "../aicore/errors.ts";
import { listDeployments, invalidateDeploymentCache, type Deployment } from "../aicore/models.ts";

// Coalesce streamed tokens into at most one webview post per interval. Short
// enough to still read as live typing, long enough that a fast model does not
// drive one render per token.
const STREAM_POST_INTERVAL_MS = 50;

interface PendingApproval {
  id: string;
  command: string;
  reason: string;
  severity?: "caution" | "dangerous";
  resolve: (approved: boolean) => void;
}

export class CoupletPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: Session;
  private streamingText = "";
  private pendingApproval: PendingApproval | null = null;
  private touchedFiles: string[] = [];
  private controller: AbortController | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private hasClientSecret = false;
  // Why the last turn stopped, shown in the transcript until the next one
  // starts. Deliberately not a session message: it is local to this window and
  // must never be sent to the model as conversation.
  private turnError: string | null = null;
  private sessionList: { id: string; title: string }[] = [];
  private connectionTest: { state: "idle" | "testing" | "ok" | "error"; message?: string } = { state: "idle" };
  private models: { state: "idle" | "loading" | "ready" | "error"; list: Deployment[]; message?: string } = {
    state: "idle",
    list: [],
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.sessionList = this.tryListSessions().map(({ id, title }) => ({ id, title }));
    this.session = createSession("", "");
    this.session.filePath = this.tryCreateSessionFilePath(this.session);
    this.sessionList.unshift({ id: this.session.id, title: "New Session" });
  }

  /**
   * Best-effort creation of the session's on-disk file path. Returns undefined
   * (leaving the session unpersisted) when there is no workspace folder open —
   * a normal, common VS Code state — rather than letting getWorkspaceRoot()'s
   * exception propagate and crash extension activation or a message handler.
   */
  private tryCreateSessionFilePath(session: Session): string | undefined {
    try {
      return newSessionFilePath(getWorkspaceRoot(), session);
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort listing of on-disk sessions. Returns an empty list (rather than
   * letting getWorkspaceRoot()'s exception propagate) when there is no workspace
   * folder open — same guarding rationale as tryCreateSessionFilePath above.
   */
  private tryListSessions(): { id: string; title: string; filePath: string }[] {
    try {
      return listSessions(getWorkspaceRoot());
    } catch {
      return [];
    }
  }

  private tryGetWorkspaceRoot(): string | undefined {
    try {
      return getWorkspaceRoot();
    } catch {
      return undefined;
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "style.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"));
    const htmlUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.html");
    const template = fs.readFileSync(htmlUri.fsPath, "utf8");
    return template
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{styleUri}}", styleUri.toString())
      .replaceAll("{{scriptUri}}", scriptUri.toString());
  }

  /**
   * Pushes the accumulated reply on its own, throttled, instead of re-posting
   * the whole session on every token. postState serialises every message in the
   * conversation, so streaming through it cost O(tokens x messages): measured at
   * 20ms and 81KB per token in a 60-message session, i.e. ~10s of blocked
   * rendering for one long reply. This payload stays flat regardless of how long
   * the conversation is.
   */
  private postStreamThrottled() {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.view?.webview.postMessage({ type: "stream", text: this.streamingText });
    }, STREAM_POST_INTERVAL_MS);
  }

  private cancelStreamPost() {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  /**
   * SecretStorage.get() hits the OS keychain, which is far too expensive to do
   * on every post. The webview only needs to know whether a secret exists, so
   * cache that flag and refresh it at the points where it can actually change.
   */
  private async refreshSecretFlag() {
    this.hasClientSecret = !!(await this.secrets.get(CLIENT_SECRET_KEY));
  }

  /**
   * Credentials belong to the person, not to the folder. They used to be
   * written with ConfigurationTarget.Workspace, which meant they lived in one
   * project's .vscode/settings.json and the extension looked unconfigured — "it
   * worked yesterday" — the moment another folder was opened. Global keeps them
   * with the user across every workspace.
   *
   * Any workspace-scoped copy from an earlier version is removed at the same
   * time, because a workspace value shadows the global one and the panel would
   * otherwise keep showing a stale credential it is no longer writing to.
   */
  private async saveGlobalSetting(key: string, value: unknown) {
    const cfg = vscode.workspace.getConfiguration("couplet");
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    try {
      if (cfg.inspect(key)?.workspaceValue !== undefined) {
        await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      }
    } catch {
      // No folder open, or a read-only workspace file: the global write above
      // is what matters, so do not fail the save over the cleanup.
    }
  }

  private async saveCredentialSetting(key: string, value: unknown) {
    await this.saveGlobalSetting(key, value);
    this.onCredentialsChanged();
  }

  /**
   * Drops everything derived from the old credentials. Without this an edited
   * client id kept using the token minted for the previous one, and a corrected
   * setting appeared to change nothing.
   */
  private onCredentialsChanged() {
    invalidateToken();
    invalidateDeploymentCache();
    this.connectionTest = { state: "idle" };
  }

  private async postState() {
    const cfg = vscode.workspace.getConfiguration("couplet");
    const hasClientSecret = this.hasClientSecret;
    this.view?.webview.postMessage({
      type: "state",
      session: this.session,
      streamingText: this.streamingText,
      streaming: this.controller !== null,
      pendingApproval: this.pendingApproval
        ? {
            id: this.pendingApproval.id,
            command: this.pendingApproval.command,
            reason: this.pendingApproval.reason,
            severity: this.pendingApproval.severity,
          }
        : null,
      touchedFiles: this.touchedFiles,
      turnError: this.turnError,
      // Cheap (a character count over the transcript) and the only warning the
      // user gets before compaction rewrites their history at 75%.
      contextUsage: {
        tokens: estimateTokens(this.session.messages),
        budget: cfg.get<number>("contextBudget", 100_000),
      },
      sessionList: this.sessionList,
      approvalMode: cfg.get<string>("approvalMode", "ask"),
      model: cfg.get<string>("model", ""),
      config: {
        clientId: cfg.get<string>("clientId", ""),
        aiCoreBaseUrl: cfg.get<string>("aiCoreBaseUrl", ""),
        tokenUrl: cfg.get<string>("tokenUrl", ""),
        resourceGroup: cfg.get<string>("resourceGroup", "default"),
        hasClientSecret,
      },
      connectionTest: this.connectionTest,
      models: this.models,
    });
  }

  /**
   * Lists the RUNNING deployments in the configured resource group, which is
   * what "available models" means for SAP AI Core — you can only talk to a
   * model someone has deployed, and the deployment id is what routes the
   * request. Picking a model therefore sets deploymentId, not just a label.
   */
  private async refreshModels() {
    if (this.models.state === "loading") return;
    this.models = { state: "loading", list: this.models.list };
    this.postState();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const list = await listDeployments(controller.signal);
      this.models = {
        state: "ready",
        list,
        message: list.length ? undefined : "No running deployments found in this resource group.",
      };
    } catch (err) {
      const classified = classifyError(err);
      this.models = {
        state: "error",
        list: [],
        message: classified.category === "aborted" ? "Timed out after 30s." : classified.message,
      };
    } finally {
      clearTimeout(timeout);
      this.postState();
    }
  }

  /**
   * Verifies credentials, the endpoint, and streaming — the failure that
   * matters most on first run, and the one worth catching here rather than
   * midway through a real task.
   *
   * Listing deployments comes first because it needs nothing but the
   * credentials: it separates "your client id/secret/URL is wrong" from "the
   * model call itself failed", and it fills the model list, which used to be
   * unreachable until a connection test passed — and the test could not pass
   * until a deployment was already configured.
   */
  private async testConnection() {
    this.connectionTest = { state: "testing" };
    this.postState();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let listed = false;
    try {
      const list = await listDeployments(controller.signal);
      listed = true;
      this.models = { state: "ready", list };
      if (!list.length) {
        const { resourceGroup } = readConfig();
        this.models.message = "No running deployments found in this resource group.";
        this.connectionTest = {
          state: "error",
          message: `Credentials are valid, but resource group "${resourceGroup}" has no running model deployment.`,
        };
        return;
      }
      this.postState();

      let streamed = "";
      const reply = await chat(
        [{ role: "user", content: "Reply with the single word: OK" }],
        [],
        (delta) => (streamed += delta),
        controller.signal,
      );
      const text = (reply.content ?? streamed).trim();
      this.connectionTest = {
        state: "ok",
        message: text ? `Connected. Model replied: "${text.slice(0, 40)}"` : "Connected, but the reply was empty.",
      };
    } catch (err) {
      const classified = classifyError(err);
      const message = classified.category === "aborted" ? "Timed out after 30s." : classified.message;
      this.connectionTest = { state: "error", message };
      // The credentials never got as far as listing, so the model list on
      // screen is not trustworthy either.
      if (!listed) this.models = { state: "error", list: [], message };
    } finally {
      clearTimeout(timeout);
      this.postState();
    }
  }

  private async handleMessage(msg: any) {
    switch (msg.type) {
      case "ready":
        await this.refreshSecretFlag();
        this.postState();
        break;
      case "userSend":
        if (this.controller !== null) {
          break;
        }
        await this.startTurn(msg.text);
        break;
      case "approve":
      case "deny": {
        const pending = this.pendingApproval;
        if (pending && pending.id === msg.id) {
          pending.resolve(msg.type === "approve");
          this.pendingApproval = null;
          this.postState();
        }
        break;
      }
      case "stop":
        this.cancelStreamPost();
        this.controller?.abort();
        if (this.pendingApproval) {
          this.pendingApproval.resolve(false);
          this.pendingApproval = null;
        }
        this.postState();
        break;
      case "newSession":
        this.session = createSession("", "");
        this.session.filePath = this.tryCreateSessionFilePath(this.session);
        this.sessionList.unshift({ id: this.session.id, title: "New Session" });
        this.touchedFiles = [];
        this.turnError = null;
        this.postState();
        break;
      case "selectSession": {
        const entry = this.tryListSessions().find((s) => s.id === msg.id);
        if (entry) {
          try {
            this.session = loadSession(entry.filePath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Couplet: failed to load session: ${message}`);
            break;
          }
          this.touchedFiles = [];
          this.turnError = null;
          this.postState();
        }
        break;
      }
      case "deleteSession": {
        const root = this.tryGetWorkspaceRoot();
        const entry = this.tryListSessions().find((s) => s.id === msg.id);
        if (entry) {
          try {
            deleteSession(entry.filePath);
            if (root) deleteCheckpointsFrom(root, msg.id, 0);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Couplet: failed to delete session: ${message}`);
            break;
          }
        }
        this.sessionList = this.sessionList.filter((s) => s.id !== msg.id);
        if (this.session.id === msg.id) {
          this.session = createSession("", "");
          this.session.filePath = this.tryCreateSessionFilePath(this.session);
          this.sessionList.unshift({ id: this.session.id, title: "New Session" });
          this.touchedFiles = [];
          this.turnError = null;
        }
        this.postState();
        break;
      }
      case "updateSetting": {
        const allowedKeys = new Set(["clientId", "aiCoreBaseUrl", "tokenUrl", "resourceGroup"]);
        if (allowedKeys.has(msg.key) && typeof msg.value === "string") {
          // Cleaned on the way in as well as on the way out, so the panel shows
          // the URL that will actually be called rather than the raw paste.
          const value =
            msg.key === "tokenUrl"
              ? normalizeAuthUrl(msg.value)
              : msg.key === "aiCoreBaseUrl"
                ? normalizeApiUrl(msg.value)
                : msg.value.trim();
          await this.saveCredentialSetting(msg.key, value);
          this.postState();
        }
        break;
      }
      case "updateSecret": {
        if (typeof msg.value === "string" && msg.value.length > 0) {
          await this.secrets.store(CLIENT_SECRET_KEY, msg.value);
          this.onCredentialsChanged();
          await this.refreshSecretFlag();
          this.postState();
        }
        break;
      }
      case "testConnection":
        // testConnection lists the deployments itself, so the model list is
        // already loaded by the time it returns.
        if (this.connectionTest.state !== "testing") await this.testConnection();
        break;
      case "refreshModels":
        await this.refreshModels();
        break;
      case "selectModel": {
        const chosen = this.models.list.find((d) => d.id === msg.deploymentId);
        if (!chosen) break;
        const cfg = vscode.workspace.getConfiguration("couplet");
        // Store the model, not the deployment id. Ids change whenever a model
        // is redeployed, so a stored id silently starts 404ing; the label is
        // stable and resolves to whatever deployment currently serves it. Any
        // id pinned by an earlier version is cleared for the same reason.
        await this.saveGlobalSetting("model", chosen.label);
        for (const scope of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) {
          const inspected = cfg.inspect("deploymentId");
          const set =
            scope === vscode.ConfigurationTarget.Workspace
              ? inspected?.workspaceValue !== undefined
              : inspected?.globalValue !== undefined;
          if (set) {
            try {
              await cfg.update("deploymentId", undefined, scope);
            } catch {
              // Nothing to unpin here (no folder open, read-only settings).
            }
          }
        }
        invalidateDeploymentCache();
        this.postState();
        break;
      }
      case "openSettingsJson":
        vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsJson");
        break;
      case "toggleApprovalMode": {
        const cfg = vscode.workspace.getConfiguration("couplet");
        const current = cfg.get<string>("approvalMode", "ask");
        await cfg.update("approvalMode", current === "ask" ? "auto" : "ask", vscode.ConfigurationTarget.Workspace);
        this.postState();
        break;
      }
      case "openFile": {
        // The path here originates in model output, so it is untrusted: run it
        // through the same containment check the tools use before handing it to
        // the editor, or a crafted reply could get the user to open anything on
        // disk with one click.
        const root = this.tryGetWorkspaceRoot();
        if (!root || typeof msg.file !== "string") break;
        let abs: string;
        try {
          abs = resolveWithinRoot(root, msg.file);
        } catch {
          vscode.window.showErrorMessage(`Couplet: refused to open a path outside the workspace: ${msg.file}`);
          break;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
          const line = Number.isInteger(msg.line) && msg.line > 0 ? Math.min(msg.line - 1, doc.lineCount - 1) : undefined;
          await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
            selection: line === undefined ? undefined : new vscode.Range(line, 0, line, 0),
          });
        } catch {
          vscode.window.showInformationMessage(`Couplet: could not open ${msg.file}`);
        }
        break;
      }
      case "openDiff":
        // couplet.openDiff is registered in Task 14; calling it before that is a silent no-op.
        vscode.commands.executeCommand("couplet.openDiff", msg.file);
        break;
      case "revertFile":
        // couplet.revertFile is registered in Task 14; calling it before that is a silent no-op.
        vscode.commands.executeCommand("couplet.revertFile", msg.file);
        break;
      case "rewindToTurn": {
        if (this.controller !== null) break; // don't rewind mid-turn
        const root = this.tryGetWorkspaceRoot();
        if (!root) break;
        const turnIndex = Number(msg.turnIndex);
        if (!Number.isInteger(turnIndex) || turnIndex < 0) break;
        const choice = await vscode.window.showWarningMessage(
          "Rewind to before this turn? Later messages will be discarded and any files it touched will be restored.",
          { modal: true },
          "Rewind",
        );
        if (choice !== "Rewind") break;
        try {
          const result = await rewindToTurn(root, this.session, turnIndex);
          if (!result) {
            vscode.window.showInformationMessage("Couplet: nothing to rewind for that turn.");
            break;
          }
          if (result.unrestorable.length) {
            vscode.window.showWarningMessage(
              `Couplet: could not restore (changed by a shell command): ${result.unrestorable.join(", ")}`,
            );
          }
          if (result.rejected.length) {
            vscode.window.showErrorMessage(
              `Couplet: refused to restore ${result.rejected.length} path(s) outside the workspace — this checkpoint file may have been tampered with: ${result.rejected.join(", ")}`,
            );
          }
          this.touchedFiles = [];
          this.turnError = null;
          this.postState();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Couplet: rewind failed: ${message}`);
        }
        break;
      }
    }
  }

  private async startTurn(text: string) {
    this.streamingText = "";
    this.touchedFiles = [];
    this.turnError = null;
    this.controller = new AbortController();
    this.postState();

    const ui: UiPort = {
      streamAssistantText: (delta) => {
        this.streamingText += delta;
        this.postStreamThrottled();
      },
      // Whatever was streaming has now been appended to the transcript, so drop
      // the streaming buffer as well as any post still queued for it — leaving
      // it would render the same reply twice, once as a message and once as a
      // live block.
      messagesChanged: () => {
        this.cancelStreamPost();
        this.streamingText = "";
        this.postState();
      },
      showError: (message) => {
        // Same buffer reset as messagesChanged: anything already streamed has
        // been salvaged into the transcript by the turn loop.
        this.cancelStreamPost();
        this.streamingText = "";
        this.turnError = message;
        this.postState();
      },
      requestApproval: ({ command, reason, severity }) =>
        new Promise<boolean>((resolve) => {
          this.pendingApproval = { id: crypto.randomBytes(4).toString("hex"), command, reason, severity, resolve };
          this.postState();
        }),
      showTurnDiff: (files) => {
        this.touchedFiles = files;
        this.postState();
      },
    };

    if (!this.session.title) {
      this.session.title = text.slice(0, 60);
      const entry = this.sessionList.find((s) => s.id === this.session.id);
      if (entry) entry.title = this.session.title;
      try {
        if (this.session.filePath) updateSessionTitle(this.session.filePath, this.session.title);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Couplet: failed to save session title: ${message}`);
      }
    }

    await runTurn(this.session, text, ui, this.controller.signal);

    // Drop any queued stream post first: it carries the pre-reset text and
    // would land after this postState, resurrecting a finished reply as a
    // phantom streaming block.
    this.cancelStreamPost();
    this.streamingText = "";
    this.controller = null;
    this.postState();
  }
}
