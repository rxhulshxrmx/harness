import * as vscode from "vscode";
import * as path from "node:path";
import { setExtensionContext } from "./aicore/context.ts";
import { CoupletPanel } from "./ui/panel.ts";
import { diffTracker, BeforeContentProvider } from "./state/diffTracker.ts";
import "./tools/readFile.ts";
import "./tools/listDir.ts";
import "./tools/grep.ts";
import "./tools/searchReplace.ts";
import "./tools/bash.ts";

export function activate(context: vscode.ExtensionContext) {
  setExtensionContext(context);

  const panel = new CoupletPanel(context.extensionUri, context.secrets);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("couplet.chat", panel));

  context.subscriptions.push(
    vscode.commands.registerCommand("couplet.newSession", () => {
      vscode.commands.executeCommand("workbench.view.extension.couplet");
    }),
  );

  const beforeProvider = new BeforeContentProvider(diffTracker);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("couplet-before", beforeProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand("couplet.openDiff", async (file: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const before = diffTracker.getSnapshot(file);
      if (before === undefined) {
        vscode.window.showInformationMessage(`Couplet: ${file} was changed by a shell command — showing git diff instead.`);
        await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(path.join(root, file)));
        return;
      }
      const beforeUri = vscode.Uri.parse(`couplet-before:${encodeURIComponent(file)}`);
      const afterUri = vscode.Uri.file(path.join(root, file));
      await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `Couplet: ${file} (this turn)`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("couplet.revertFile", async (file: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const before = diffTracker.getSnapshot(file);
      const abs = path.join(root, file);
      const uri = vscode.Uri.file(abs);
      const edit = new vscode.WorkspaceEdit();
      if (before === null) {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
      } else if (typeof before === "string") {
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(uri, fullRange, before);
      } else {
        vscode.window.showWarningMessage(`Couplet: no exact snapshot for ${file} (changed by a shell command) — cannot auto-revert.`);
        return;
      }
      await vscode.workspace.applyEdit(edit);
      if (before !== null) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
      }
    }),
  );
}

export function deactivate() {}
