import * as fs from "node:fs";
import { chat as realChat } from "../aicore/client.ts";
import type { Session } from "../state/session.ts";
import type { Message } from "../aicore/types.ts";

const COMPACTION_PROMPT = `Summarize this coding session so a fresh agent can continue seamlessly. Include:
the user's overall goal; all decisions made; every file created or modified and
how; current state of the task; unresolved problems; exact next steps. Output
plain text, max 800 words.`;

// How many of the most recent user-initiated turns to keep verbatim instead
// of folding into the summary — losing the assistant's most recent tool
// calls/results right when the model needs them most (immediately after
// compaction) was the main cost of always collapsing to just the bare last
// user message. A "turn" runs from a user message up to (not including) the
// next user message, so splitting there never leaves a dangling tool_calls
// message without its tool-result, or a tool-result without its call.
const KEEP_RECENT_TURNS = 2;

// Prefix marking the message that replaces the compacted history. It has to be
// a user message — that is the only role the API lets us hand a summary back in
// — but it is not something the user said, so the panel renders it as a divider
// rather than as their words. The webview matches this exact string; it is
// copied verbatim rather than bundled, so it cannot import this constant.
export const SUMMARY_PREFIX = "[Session summary]";

// Finds the earliest safe split index that keeps at most `keepTurns` of the
// most recent turns intact, falling back to fewer turns (down to just the
// single most recent user message, matching the old always-collapse
// behavior) when there isn't enough history to leave anything older to
// summarize away.
function findSplitIndex(messages: Message[], keepTurns: number): number {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  for (let keep = Math.min(keepTurns, userIndices.length); keep >= 1; keep--) {
    const idx = userIndices[userIndices.length - keep];
    if (idx > 0) return idx;
  }
  return messages.length;
}

export async function compact(session: Session, chatFn: typeof realChat = realChat): Promise<void> {
  const lastUserMessage = [...session.messages].reverse().find((m) => m.role === "user");
  const splitIndex = findSplitIndex(session.messages, KEEP_RECENT_TURNS);
  const hasSafeSplit = splitIndex < session.messages.length;

  const older = hasSafeSplit ? session.messages.slice(0, splitIndex) : session.messages;
  const recent = hasSafeSplit ? session.messages.slice(splitIndex) : lastUserMessage ? [lastUserMessage] : [];

  const transcriptForSummary = [...older, { role: "user" as const, content: COMPACTION_PROMPT }];
  const summaryMsg = await chatFn(transcriptForSummary, [], () => {});
  const summary = summaryMsg.content ?? "(no summary produced)";

  if (session.filePath) {
    fs.appendFileSync(session.filePath, JSON.stringify({ type: "compaction" }) + "\n");
  }

  session.messages = [{ role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }, ...recent];
}
