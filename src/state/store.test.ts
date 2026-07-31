import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendToStore, listSessions, loadSession, newSessionFilePath } from "./store.ts";
import { createSession } from "./session.ts";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-store-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendToStore creates the file with a meta line then appends messages", () => {
  const session = createSession("hello world", "gpt-4o");
  session.filePath = newSessionFilePath(dir, session);
  appendToStore(session, { role: "user", content: "hello world" });
  appendToStore(session, { role: "assistant", content: "hi there" });

  const lines = fs.readFileSync(session.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "meta");
  assert.equal(lines[0].title, "hello world");
  assert.equal(lines[1].role, "user");
  assert.equal(lines[2].role, "assistant");
});

test("listSessions finds sessions under .harness/sessions and reads their titles", () => {
  const session = createSession("second session", "gpt-4o");
  session.filePath = newSessionFilePath(dir, session);
  appendToStore(session, { role: "user", content: "second session" });

  const sessions = listSessions(dir);
  assert.ok(sessions.some((s) => s.title === "second session"));
});

test("loadSession reconstructs the full message list", () => {
  const session = createSession("third", "gpt-4o");
  session.filePath = newSessionFilePath(dir, session);
  appendToStore(session, { role: "user", content: "third" });
  appendToStore(session, { role: "assistant", content: "reply" });

  const loaded = loadSession(session.filePath);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[1].content, "reply");
});
