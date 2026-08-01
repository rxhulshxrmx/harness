import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordRead, isStale, clearTracked } from "./fileTracker.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "couplet-filetracker-test-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clearTracked();
});

test("a file never read is stale", () => {
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "hello");
  assert.equal(isStale(file), true);
});

test("a file is not stale immediately after being read", () => {
  const file = path.join(dir, "b.txt");
  fs.writeFileSync(file, "hello");
  recordRead(file);
  assert.equal(isStale(file), false);
});

test("a file becomes stale after being modified on disk since the last read", async () => {
  const file = path.join(dir, "c.txt");
  fs.writeFileSync(file, "hello");
  recordRead(file);
  // Bump the mtime forward explicitly — some filesystems have coarse mtime
  // resolution, so a fast re-write in the same tick isn't guaranteed to move it.
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 5000));
  assert.equal(isStale(file), true);
});

test("re-recording a read after a write clears staleness for that write", () => {
  const file = path.join(dir, "d.txt");
  fs.writeFileSync(file, "hello");
  recordRead(file);
  fs.writeFileSync(file, "hello again");
  recordRead(file);
  assert.equal(isStale(file), false);
});

test("a deleted file is treated as stale", () => {
  const file = path.join(dir, "e.txt");
  fs.writeFileSync(file, "hello");
  recordRead(file);
  fs.rmSync(file);
  assert.equal(isStale(file), true);
});
