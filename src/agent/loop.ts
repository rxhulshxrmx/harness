import * as vscode from "vscode";
import { chat } from "../aicore/client.ts";
import { estimateTokens } from "./tokens.ts";
import { systemMessage } from "./systemPrompt.ts";
import { compact } from "./compaction.ts";
import { getToolSchemas, runTool, getWorkspaceRoot } from "../tools/index.ts";
import type { Session } from "../state/session.ts";
import { appendToStore } from "../state/store.ts";

const MAX_STEPS = 40;

export interface UiPort {
  streamAssistantText(delta: string): void;
  requestApproval(command: string): Promise<boolean>;
  showTurnDiff(files: string[]): void;
  showError(message: string): void;
}

export async function runTurn(session: Session, userText: string, ui: UiPort, signal: AbortSignal): Promise<void> {
  session.messages.push({ role: "user", content: userText });
  appendToStore(session, { role: "user", content: userText });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;

      const cfg = vscode.workspace.getConfiguration("forge");
      const budget = cfg.get<number>("contextBudget", 100_000);
      if (estimateTokens(session.messages) > budget * 0.75) {
        await compact(session);
      }

      const assistant = await chat(
        [systemMessage(session), ...session.messages],
        getToolSchemas(),
        (d) => ui.streamAssistantText(d),
        signal,
      );
      session.messages.push(assistant);
      appendToStore(session, assistant);

      if (!assistant.tool_calls?.length) return;

      for (const call of assistant.tool_calls) {
        if (signal.aborted) return;
        const result = await runTool(call.function.name, call.function.arguments, {
          workspaceRoot: getWorkspaceRoot(),
          signal,
        });
        const msg = { role: "tool" as const, tool_call_id: call.id, content: result };
        session.messages.push(msg);
        appendToStore(session, msg);
      }
    }
    ui.showError(`Step budget (${MAX_STEPS}) exhausted for this turn.`);
  } catch (err) {
    ui.showError(err instanceof Error ? err.message : String(err));
  }
}
