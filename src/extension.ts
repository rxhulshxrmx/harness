import * as vscode from "vscode";
import { chat } from "./aicore/client.ts";
import { ForgePanel } from "./ui/panel.ts";
import "./tools/readFile.ts";
import "./tools/listDir.ts";
import "./tools/grep.ts";
import "./tools/searchReplace.ts";
import "./tools/bash.ts";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Forge");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.ping", async () => {
      output.show(true);
      output.appendLine("Sending: say hello");
      try {
        const reply = await chat([{ role: "user", content: "say hello" }], [], (delta) => output.append(delta));
        output.appendLine("");
        output.appendLine(`[done] finish content length: ${(reply.content ?? "").length}`);
      } catch (err) {
        output.appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  const panel = new ForgePanel(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("forge.chat", panel));

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.newSession", () => {
      vscode.commands.executeCommand("workbench.view.extension.forge");
    }),
  );
}

export function deactivate() {}
