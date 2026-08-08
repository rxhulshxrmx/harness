import * as path from "node:path";
import * as fs from "node:fs";
import type * as vscodeTypes from "vscode";
import { ALWAYS_ALLOW_KEY, type Host } from "./host.ts";
import { revealEdit as revealEditImpl } from "./tools/revealEdit.ts";

declare function require(id: "vscode"): typeof vscodeTypes;

export class VscodeHost implements Host {
  private readonly context: vscodeTypes.ExtensionContext;

  constructor(context: vscodeTypes.ExtensionContext) {
    this.context = context;
  }

  workspaceRoot(): string {
    const vscode = require("vscode");
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error("No workspace folder open.");
    return root;
  }

  getConfig<T>(key: string, defaultValue: T): T {
    const vscode = require("vscode");
    return vscode.workspace.getConfiguration("couplet").get<T>(key, defaultValue);
  }

  async getSecret(key: string): Promise<string | undefined> {
    return this.context.secrets.get(key);
  }

  getAlwaysAllowed(): string[] {
    const vscode = require("vscode");
    const cfg = vscode.workspace.getConfiguration("couplet");
    // The workspace-scoped value is deliberately never read here — see the
    // ALWAYS_ALLOW_KEY setting description for why (a cloned repo must not be
    // able to grant itself permissions via .vscode/settings.json).
    const fromUserSettings = cfg.inspect<string[]>("alwaysAllow")?.globalValue ?? [];
    const granted = this.context.workspaceState.get<string[]>(ALWAYS_ALLOW_KEY, []);
    return [...fromUserSettings, ...granted];
  }

  async writeFile(absPath: string, content: string, opts: { create: boolean }): Promise<void> {
    const vscode = require("vscode");
    const uri = vscode.Uri.file(absPath);
    const edit = new vscode.WorkspaceEdit();
    if (opts.create) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, "utf8") });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, fullRange, content);
    }
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  }

  async revealEdit(absPath: string, content: string, needle?: string): Promise<void> {
    const vscode = require("vscode");
    await revealEditImpl(vscode.Uri.file(absPath), content, needle);
  }
}
