import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { runTurn, type UiPort } from "../agent/loop.ts";
import { createSession, type Session } from "../state/session.ts";
import { newSessionFilePath } from "../state/store.ts";
import { getWorkspaceRoot } from "../tools/index.ts";

interface PendingApproval {
  id: string;
  command: string;
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

  constructor(private readonly extensionUri: vscode.Uri) {
    this.session = createSession("", "");
    this.session.filePath = this.tryCreateSessionFilePath(this.session);
    this.sessionList = [{ id: this.session.id, title: "New Session" }];
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

  private postState() {
    this.view?.webview.postMessage({
      type: "state",
      session: this.session,
      streamingText: this.streamingText,
      streaming: this.controller !== null,
      pendingApproval: this.pendingApproval ? { id: this.pendingApproval.id, command: this.pendingApproval.command } : null,
      touchedFiles: this.touchedFiles,
      sessionList: this.sessionList,
      approvalMode: vscode.workspace.getConfiguration("harness").get<string>("approvalMode", "ask"),
    });
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
        this.sessionList.push({ id: this.session.id, title: "New Session" });
        this.touchedFiles = [];
        this.postState();
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
      requestApproval: (command) =>
        new Promise<boolean>((resolve) => {
          this.pendingApproval = { id: crypto.randomBytes(4).toString("hex"), command, resolve };
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

    await runTurn(this.session, text, ui, this.controller.signal);

    this.streamingText = "";
    this.controller = null;
    this.postState();
  }
}
