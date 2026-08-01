import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveCheckpoint, getCheckpoint, listCheckpoints, deleteCheckpointsFrom, type Checkpoint } from "./checkpoints.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "couplet-checkpoints-test-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function cp(turnIndex: number, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    turnIndex,
    messageCountBefore: turnIndex * 2,
    userText: `turn ${turnIndex}`,
    files: {},
    unrestorable: [],
    ...overrides,
  };
}

test("saveCheckpoint then getCheckpoint round-trips", () => {
  saveCheckpoint(dir, "s1", cp(0, { files: { "a.ts": "old content" } }));
  const loaded = getCheckpoint(dir, "s1", 0);
  assert.equal(loaded?.userText, "turn 0");
  assert.equal(loaded?.files["a.ts"], "old content");
});

test("getCheckpoint returns null for a turn that was never saved", () => {
  assert.equal(getCheckpoint(dir, "s1", 999), null);
});

test("listCheckpoints returns all checkpoints for a session, sorted by turnIndex", () => {
  saveCheckpoint(dir, "s2", cp(2));
  saveCheckpoint(dir, "s2", cp(0));
  saveCheckpoint(dir, "s2", cp(1));
  const list = listCheckpoints(dir, "s2");
  assert.deepEqual(
    list.map((c) => c.turnIndex),
    [0, 1, 2],
  );
});

test("listCheckpoints is empty for a session with no checkpoints", () => {
  assert.deepEqual(listCheckpoints(dir, "no-such-session"), []);
});

test("checkpoints are scoped per session", () => {
  saveCheckpoint(dir, "s3a", cp(0, { userText: "a" }));
  saveCheckpoint(dir, "s3b", cp(0, { userText: "b" }));
  assert.equal(getCheckpoint(dir, "s3a", 0)?.userText, "a");
  assert.equal(getCheckpoint(dir, "s3b", 0)?.userText, "b");
});

test("evicts the oldest checkpoints beyond the cap", () => {
  for (let i = 0; i < 25; i++) saveCheckpoint(dir, "s4", cp(i));
  const list = listCheckpoints(dir, "s4");
  assert.equal(list.length, 20);
  assert.equal(list[0].turnIndex, 5);
  assert.equal(list[list.length - 1].turnIndex, 24);
});

test("deleteCheckpointsFrom removes the given turn and every later one, keeping earlier ones", () => {
  saveCheckpoint(dir, "s5", cp(0));
  saveCheckpoint(dir, "s5", cp(1));
  saveCheckpoint(dir, "s5", cp(2));
  saveCheckpoint(dir, "s5", cp(3));
  deleteCheckpointsFrom(dir, "s5", 2);
  const list = listCheckpoints(dir, "s5");
  assert.deepEqual(
    list.map((c) => c.turnIndex),
    [0, 1],
  );
});

test("deleteCheckpointsFrom on a session with no checkpoints is a no-op", () => {
  assert.doesNotThrow(() => deleteCheckpointsFrom(dir, "no-such-session", 0));
});

// Both of these reach the filesystem path: the session id is parsed out of a
// filename found in the workspace, and the turn index comes from a webview
// message. Neither may be concatenated into a path unchecked.
test("rejects session ids that could escape the checkpoints directory", () => {
  for (const id of ["../../etc", "a/b", "..", "a\\b", ""]) {
    assert.throws(() => getCheckpoint(dir, id, 0), /Unsafe session id/, id);
  }
});

test("rejects non-integer or negative turn indexes", () => {
  for (const turnIndex of [-1, 1.5, NaN, "../../../../etc/passwd" as unknown as number]) {
    assert.throws(() => getCheckpoint(dir, "s1", turnIndex), /Invalid turn index/, String(turnIndex));
  }
});

test("getCheckpoint rejects a malformed or hand-written checkpoint file", () => {
  const sessionDir = path.join(dir, ".couplet", "checkpoints", "tampered");
  fs.mkdirSync(sessionDir, { recursive: true });

  const write = (body: unknown) =>
    fs.writeFileSync(path.join(sessionDir, "checkpoint-0.json"), JSON.stringify(body));

  write({ turnIndex: 0, messageCountBefore: 0, userText: "x", files: "not-an-object", unrestorable: [] });
  assert.equal(getCheckpoint(dir, "tampered", 0), null);

  write({ turnIndex: 0, messageCountBefore: -5, userText: "x", files: {}, unrestorable: [] });
  assert.equal(getCheckpoint(dir, "tampered", 0), null);

  write({ turnIndex: 0, messageCountBefore: 0, userText: "x", files: { "a.ts": 42 }, unrestorable: [] });
  assert.equal(getCheckpoint(dir, "tampered", 0), null);

  fs.writeFileSync(path.join(sessionDir, "checkpoint-0.json"), "{ not json");
  assert.equal(getCheckpoint(dir, "tampered", 0), null);

  // A well-formed one still round-trips.
  write({ turnIndex: 0, messageCountBefore: 2, userText: "x", files: { "a.ts": "old", "b.ts": null }, unrestorable: [] });
  assert.equal(getCheckpoint(dir, "tampered", 0)?.messageCountBefore, 2);
});
