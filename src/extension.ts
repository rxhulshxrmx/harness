import * as vscode from "vscode";
import { chat } from "./aicore/client.ts";
import { runTurn } from "./agent/loop.ts";
import { createSession } from "./state/session.ts";
import "./tools/readFile.ts";
import "./tools/listDir.ts";
import "./tools/grep.ts";
import "./tools/searchReplace.ts";

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

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.runTurn", async () => {
      const text = await vscode.window.showInputBox({ prompt: "Forge task" });
      if (!text) return;
      output.show(true);
      const session = createSession(text, "debug");
      const controller = new AbortController();
      await runTurn(
        session,
        text,
        {
          streamAssistantText: (d) => output.append(d),
          requestApproval: async (cmd) => {
            const choice = await vscode.window.showWarningMessage(`Run: ${cmd}`, "Approve", "Deny");
            return choice === "Approve";
          },
          showTurnDiff: (files) => output.appendLine(`\n[touched] ${files.join(", ")}`),
          showError: (msg) => output.appendLine(`\n[error] ${msg}`),
        },
        controller.signal,
      );
    }),
  );
}

export function deactivate() {}
