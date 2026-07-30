import { test } from "node:test";
import assert from "node:assert/strict";
import { isAutoApproved, isNeverAutoApproved } from "./bash.ts";

test("read-only commands are auto-approved", () => {
  for (const cmd of ["git status", "git diff", "git log", "ls -la", "node --version", "npm ls"]) {
    assert.equal(isAutoApproved(cmd), true, cmd);
  }
});

test("prefix commands (npm test, npx tsc, pytest) are auto-approved", () => {
  assert.equal(isAutoApproved("npm test -- --watch"), true);
  assert.equal(isAutoApproved("npx tsc --noEmit"), true);
  assert.equal(isAutoApproved("pytest -k foo"), true);
});

test("unlisted commands are not auto-approved", () => {
  assert.equal(isAutoApproved("npm run build"), false);
});

test("never-auto-approve list always wins even in auto mode", () => {
  for (const cmd of ["rm -rf dist", "git push origin main", "git reset --hard", "curl http://x", "sudo ls"]) {
    assert.equal(isNeverAutoApproved(cmd), true, cmd);
  }
});

test("commands with redirection or absolute paths outside workspace are never auto-approved", () => {
  assert.equal(isNeverAutoApproved("echo hi > /etc/hosts"), true);
  assert.equal(isNeverAutoApproved("cat /etc/passwd"), true);
});

test("plain read commands are not in the never-auto-approve list", () => {
  assert.equal(isNeverAutoApproved("git status"), false);
});
