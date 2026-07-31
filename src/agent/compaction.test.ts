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
