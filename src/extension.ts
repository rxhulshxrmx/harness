import * as vscode from "vscode";
import { chat } from "./aicore/client.ts";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Forge");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.ping", async () => {
      output.show(true);
      output.appendLine("Sending: say hello");
      try {
        const reply = await chat(
          [{ role: "user", content: "say hello" }],
          [],
          (delta) => output.append(delta),
        );
        output.appendLine("");
        output.appendLine(`[done] finish content length: ${(reply.content ?? "").length}`);
      } catch (err) {
        output.appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export function deactivate() {}
