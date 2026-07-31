import * as vscode from "vscode";
import { chat } from "../aicore/client.ts";
import { estimateTokens } from "./tokens.ts";
import { systemMessage } from "./systemPrompt.ts";
import { compact } from "./compaction.ts";
import { getToolSchemas, runTool, getWorkspaceRoot, type ApprovalRequest } from "../tools/index.ts";
import type { Session } from "../state/session.ts";
import { appendToStore } from "../state/store.ts";
import { diffTracker } from "../state/diffTracker.ts";
import { interruptedToolResults } from "./toolResults.ts";
import { classifyError } from "../aicore/errors.ts";

const MAX_STEPS = 40;

export interface UiPort {
  streamAssistantText(delta: string): void;
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  showTurnDiff(files: string[]): void;
  showError(message: string): void;
}

export async function runTurn(session: Session, userText: string, ui: UiPort, signal: AbortSignal): Promise<void> {
  session.messages.push({ role: "user", content: userText });
  appendToStore(session, { role: "user", content: userText });
  diffTracker.beginTurn();

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;

      const cfg = vscode.workspace.getConfiguration("harness");
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

      const processedCallIds = new Set<string>();
      try {
        for (const call of assistant.tool_calls) {
          if (signal.aborted) break;
          const result = await runTool(call.function.name, call.function.arguments, {
            workspaceRoot: getWorkspaceRoot(),
            signal,
            requestApproval: ui.requestApproval,
          });
          const msg = { role: "tool" as const, tool_call_id: call.id, content: result };
          session.messages.push(msg);
          appendToStore(session, msg);
          processedCallIds.add(call.id);
        }
      } finally {
        for (const msg of interruptedToolResults(assistant.tool_calls, processedCallIds)) {
          session.messages.push(msg);
          appendToStore(session, msg);
        }
      }
      if (signal.aborted) return;
    }
    ui.showError(`Step budget (${MAX_STEPS}) exhausted for this turn.`);
  } catch (err) {
    const classified = classifyError(err);
    // An abort is the user clicking Stop — expected, not an error to surface.
    if (classified.category !== "aborted") ui.showError(classified.message);
  } finally {
    ui.showTurnDiff(diffTracker.endTurn());
  }
}
