import * as fs from "node:fs";
import { chat as realChat } from "../aicore/client.ts";
import type { Session } from "../state/session.ts";

const COMPACTION_PROMPT = `Summarize this coding session so a fresh agent can continue seamlessly. Include:
the user's overall goal; all decisions made; every file created or modified and
how; current state of the task; unresolved problems; exact next steps. Output
plain text, max 800 words.`;

export async function compact(session: Session, chatFn: typeof realChat = realChat): Promise<void> {
  const lastUserMessage = [...session.messages].reverse().find((m) => m.role === "user");

  const transcriptForSummary = [...session.messages, { role: "user" as const, content: COMPACTION_PROMPT }];
  const summaryMsg = await chatFn(transcriptForSummary, [], () => {});
  const summary = summaryMsg.content ?? "(no summary produced)";

  if (session.filePath) {
    fs.appendFileSync(session.filePath, JSON.stringify({ type: "compaction" }) + "\n");
  }

  session.messages = [
    { role: "user", content: `[Session summary]\n${summary}` },
    ...(lastUserMessage ? [lastUserMessage] : []),
  ];
}
