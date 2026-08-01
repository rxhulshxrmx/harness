import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { runTurn, type UiPort } from "../agent/loop.ts";
import { createSession, type Session } from "../state/session.ts";
import { listSessions, loadSession, newSessionFilePath, updateSessionTitle, deleteSession } from "../state/store.ts";
import { deleteCheckpointsFrom } from "../state/checkpoints.ts";
import { rewindToTurn } from "../state/rewind.ts";
import { getWorkspaceRoot } from "../tools/index.ts";
import { chat, CLIENT_SECRET_KEY } from "../aicore/client.ts";
import { classifyError } from "../aicore/errors.ts";

interface PendingApproval {
  id: string;
  command: string;
  reason: string;
  severity?: "caution" | "dangerous";
  resolve: (approved: boolean) => void;
}

export class HarnessPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: Session;
  private streamingText = "";
  private pendingApproval: PendingApproval | null = null;
  private touchedFiles: string[] = [];
  private controller: AbortController | null = null;
  private sessionList: { id: string; title: string }[] = [];
  private connectionTest: { state: "idle" | "testing" | "ok" | "error"; message?: string } = { state: "idle" };

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

  private async postState() {
    const cfg = vscode.workspace.getConfiguration("harness");
    const hasClientSecret = !!(await this.secrets.get(CLIENT_SECRET_KEY));
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
      sessionList: this.sessionList,
      approvalMode: cfg.get<string>("approvalMode", "ask"),
      model: cfg.get<string>("model", "") || "GPT-5",
      config: {
        clientId: cfg.get<string>("clientId", ""),
        aiCoreBaseUrl: cfg.get<string>("aiCoreBaseUrl", ""),
        tokenUrl: cfg.get<string>("tokenUrl", ""),
        resourceGroup: cfg.get<string>("resourceGroup", "default"),
        deploymentId: cfg.get<string>("deploymentId", ""),
        hasClientSecret,
      },
      connectionTest: this.connectionTest,
    });
  }

  /**
   * Sends one trivial completion to verify credentials, the endpoint, and
   * streaming actually work — the failure that matters most on first run, and
   * the one worth catching here rather than midway through a real task.
   */
  private async testConnection() {
    this.connectionTest = { state: "testing" };
    this.postState();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
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
      this.connectionTest = {
        state: "error",
        message: classified.category === "aborted" ? "Timed out after 30s." : classified.message,
      };
    } finally {
      clearTimeout(timeout);
      this.postState();
    }
  }

  private async handleMessage(msg: any) {
    switch (msg.type) {
      case "ready":
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
        this.postState();
        break;
      case "selectSession": {
        const entry = this.tryListSessions().find((s) => s.id === msg.id);
        if (entry) {
          try {
            this.session = loadSession(entry.filePath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Harness: failed to load session: ${message}`);
            break;
          }
          this.touchedFiles = [];
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
            vscode.window.showErrorMessage(`Harness: failed to delete session: ${message}`);
            break;
          }
        }
        this.sessionList = this.sessionList.filter((s) => s.id !== msg.id);
        if (this.session.id === msg.id) {
          this.session = createSession("", "");
          this.session.filePath = this.tryCreateSessionFilePath(this.session);
          this.sessionList.unshift({ id: this.session.id, title: "New Session" });
          this.touchedFiles = [];
        }
        this.postState();
        break;
      }
      case "updateSetting": {
        const allowedKeys = new Set(["deploymentId", "clientId", "aiCoreBaseUrl", "tokenUrl", "resourceGroup"]);
        if (allowedKeys.has(msg.key)) {
          await vscode.workspace
            .getConfiguration("harness")
            .update(msg.key, msg.value, vscode.ConfigurationTarget.Workspace);
          this.postState();
        }
        break;
      }
      case "updateSecret": {
        if (typeof msg.value === "string" && msg.value.length > 0) {
          await this.secrets.store(CLIENT_SECRET_KEY, msg.value);
          this.postState();
        }
        break;
      }
      case "testConnection":
        if (this.connectionTest.state !== "testing") await this.testConnection();
        break;
      case "openSettingsJson":
        vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsJson");
        break;
      case "toggleApprovalMode": {
        const cfg = vscode.workspace.getConfiguration("harness");
        const current = cfg.get<string>("approvalMode", "ask");
        await cfg.update("approvalMode", current === "ask" ? "auto" : "ask", vscode.ConfigurationTarget.Workspace);
        this.postState();
        break;
      }
      case "openDiff":
        // harness.openDiff is registered in Task 14; calling it before that is a silent no-op.
        vscode.commands.executeCommand("harness.openDiff", msg.file);
        break;
      case "revertFile":
        // harness.revertFile is registered in Task 14; calling it before that is a silent no-op.
        vscode.commands.executeCommand("harness.revertFile", msg.file);
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
            vscode.window.showInformationMessage("Harness: nothing to rewind for that turn.");
            break;
          }
          if (result.unrestorable.length) {
            vscode.window.showWarningMessage(
              `Harness: could not restore (changed by a shell command): ${result.unrestorable.join(", ")}`,
            );
          }
          if (result.rejected.length) {
            vscode.window.showErrorMessage(
              `Harness: refused to restore ${result.rejected.length} path(s) outside the workspace — this checkpoint file may have been tampered with: ${result.rejected.join(", ")}`,
            );
          }
          this.touchedFiles = [];
          this.postState();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Harness: rewind failed: ${message}`);
        }
        break;
      }
    }
  }

  private async startTurn(text: string) {
    this.streamingText = "";
    this.touchedFiles = [];
    this.controller = new AbortController();
    this.postState();

    const ui: UiPort = {
      streamAssistantText: (delta) => {
        this.streamingText += delta;
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
      showError: (message) => {
        vscode.window.showErrorMessage(`Harness: ${message}`);
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
        vscode.window.showErrorMessage(`Harness: failed to save session title: ${message}`);
      }
    }

    await runTurn(this.session, text, ui, this.controller.signal);

    this.streamingText = "";
    this.controller = null;
    this.postState();
  }
}
