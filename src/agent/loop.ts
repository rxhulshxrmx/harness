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
import { saveCheckpoint } from "../state/checkpoints.ts";

const MAX_STEPS = 40;

export interface UiPort {
  streamAssistantText(delta: string): void;
  /**
   * The transcript has gained a message. Called as soon as one is appended
   * rather than only at the end of the turn, so the user's own message shows up
   * the moment they send it — it used to sit invisible until the whole turn
   * finished, which left no sign the extension had received anything — and so
   * tool calls appear as they run.
   */
  messagesChanged(): void;
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  showTurnDiff(files: string[]): void;
  /**
   * A turn could not finish. Belongs in the transcript, next to the message
   * that failed — a toast in the corner disappears, and leaves the chat looking
   * as though the agent simply stopped talking.
   */
  showError(message: string): void;
}

export async function runTurn(session: Session, userText: string, ui: UiPort, signal: AbortSignal): Promise<void> {
  const turnIndex = session.messages.filter((m) => m.role === "user").length;
  const userMessage = { role: "user" as const, content: userText };
  session.messages.push(userMessage);
  appendToStore(session, userMessage);
  ui.messagesChanged();
  diffTracker.beginTurn();
  let partial = "";

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;

      const cfg = vscode.workspace.getConfiguration("couplet");
      const budget = cfg.get<number>("contextBudget", 100_000);
      if (estimateTokens(session.messages) > budget * 0.75) {
        await compact(session);
      }

      // Kept alongside the UI's copy so a failure part-way through a reply can
      // still commit what did arrive. Losing half an answer to a dropped
      // connection wastes the tokens that produced it.
      partial = "";
      const assistant = await chat(
        [systemMessage(session), ...session.messages],
        getToolSchemas(),
        (d) => {
          partial += d;
          ui.streamAssistantText(d);
        },
        signal,
      );
      partial = "";
      session.messages.push(assistant);
      appendToStore(session, assistant);
      ui.messagesChanged();

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
          ui.messagesChanged();
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
    // Whatever the model had already said before the failure belongs in the
    // transcript: it is real output, and dropping it also drops the context the
    // next turn would build on.
    if (partial) {
      const salvaged = { role: "assistant" as const, content: partial };
      session.messages.push(salvaged);
      appendToStore(session, salvaged);
    }
    // An abort is the user clicking Stop — expected, not an error to surface.
    if (classified.category !== "aborted") ui.showError(classified.message);
    else ui.messagesChanged();
  } finally {
    const touchedFiles = diffTracker.endTurn();
    // Found by reference, not by the count captured at turn start: a
    // mid-turn compact() can shrink session.messages by replacing older
    // messages with a summary, which would shift a plain index captured
    // up front out from under this turn's actual position.
    const messageCountBefore = session.messages.indexOf(userMessage);
    if (messageCountBefore !== -1) {
      const files: Record<string, string | null> = {};
      const unrestorable: string[] = [];
      for (const file of touchedFiles) {
        const snapshot = diffTracker.getSnapshot(file);
        if (snapshot === undefined) unrestorable.push(file);
        else files[file] = snapshot;
      }
      try {
        saveCheckpoint(getWorkspaceRoot(), session.id, { turnIndex, messageCountBefore, userText, files, unrestorable });
      } catch {
        // Best-effort — e.g. no workspace folder open. Rewind for this turn
        // just won't be available; nothing else depends on it succeeding.
      }
    }
    ui.showTurnDiff(touchedFiles);
  }
}
