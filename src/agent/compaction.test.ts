import { test } from "node:test";
import assert from "node:assert/strict";
import { compact } from "./compaction.ts";
import type { Session } from "../state/session.ts";

test("compact replaces the transcript with a summary + last user message, keeping full history on disk separately", async () => {
  const session: Session = {
    id: "1",
    title: "t",
    createdAt: "now",
    model: "m",
    messages: [
      { role: "user", content: "build feature X" },
      { role: "assistant", content: "ok, exploring" },
      { role: "tool", content: "file contents...", tool_call_id: "c1" },
      { role: "assistant", content: "done with step 1" },
      { role: "user", content: "now add tests" },
    ],
  };

  const fakeChat = async (_messages: any, _tools: any, onDelta: (t: string) => void) => {
    onDelta("Summary: implemented X, next add tests.");
    return { role: "assistant" as const, content: "Summary: implemented X, next add tests." };
  };

  await compact(session, fakeChat);

  assert.equal(session.messages.length, 2);
  assert.match(session.messages[0].content!, /^\[Session summary\]/);
  assert.match(session.messages[0].content!, /implemented X/);
  assert.equal(session.messages[1].content, "now add tests");
});

test("compact keeps the last two full turns verbatim when enough history exists, summarizing only what's older", async () => {
  const session: Session = {
    id: "1",
    title: "t",
    createdAt: "now",
    model: "m",
    messages: [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "working on turn 1" },
      { role: "user", content: "turn 2" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "tool output for turn 2" },
      { role: "assistant", content: "done with turn 2" },
      { role: "user", content: "turn 3" },
      { role: "assistant", content: "working on turn 3" },
    ],
  };

  const seenTranscripts: any[] = [];
  const fakeChat = async (messages: any) => {
    seenTranscripts.push(messages);
    return { role: "assistant" as const, content: "Summary of turn 1." };
  };

  await compact(session, fakeChat);

  // Only "turn 1" (and its assistant reply) should have been sent for
  // summarization — turns 2 and 3 are kept verbatim.
  const summarized = seenTranscripts[0];
  assert.ok(summarized.some((m: any) => m.content === "turn 1"));
  assert.ok(!summarized.some((m: any) => m.content === "turn 2"));
  assert.ok(!summarized.some((m: any) => m.content === "turn 3"));

  assert.match(session.messages[0].content!, /^\[Session summary\]/);
  assert.match(session.messages[0].content!, /Summary of turn 1/);
  // turn 2 (4 messages) + turn 3 (2 messages), fully intact including the
  // tool_calls/tool-result pairing.
  assert.equal(session.messages.length, 1 + 4 + 2);
  assert.equal(session.messages[1].content, "turn 2");
  assert.equal(session.messages[2].tool_calls?.[0].id, "c1");
  assert.equal(session.messages[3].tool_call_id, "c1");
  assert.equal(session.messages[5].content, "turn 3");
});

test("compact appends a compaction marker line to the session's JSONL file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-compact-"));
  const filePath = path.join(dir, "s.jsonl");
  fs.writeFileSync(filePath, JSON.stringify({ type: "meta", title: "t" }) + "\n");

  const session: Session = {
    id: "1",
    title: "t",
    createdAt: "now",
    model: "m",
    filePath,
    messages: [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ],
  };
  const fakeChat = async () => ({ role: "assistant" as const, content: "summary text" });

  await compact(session, fakeChat);

  const lines = fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === "compaction"));
  fs.rmSync(dir, { recursive: true, force: true });
});
