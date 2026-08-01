import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWithinRoot, truncate, HARD_EXCLUDES, loadWorkspaceIgnore } from "./index.ts";

test("resolveWithinRoot allows paths inside the root", () => {
  const resolved = resolveWithinRoot("/ws", "src/a.ts");
  assert.equal(resolved, "/ws/src/a.ts");
});

test("resolveWithinRoot rejects paths that escape the root", () => {
  assert.throws(() => resolveWithinRoot("/ws", "../outside.ts"), /escapes workspace root/);
  assert.throws(() => resolveWithinRoot("/ws", "/etc/passwd"), /escapes workspace root/);
});

test("truncate leaves short text untouched", () => {
  assert.equal(truncate("hello"), "hello");
});

// Session transcripts and checkpoints hold verbatim file contents and tool
// output. A rename must never leave an older data directory searchable — that
// is precisely how the agent would end up able to grep its own history for
// secrets it was meant to be kept away from.
test("agent data directories are hard-excluded under both the current and pre-rename names", () => {
  for (const dir of [".couplet", ".harness"]) {
    assert.ok(HARD_EXCLUDES.has(dir), `${dir} must be hard-excluded from walks and searches`);
  }
});

test("the ignore loader honours the legacy .harnessignore as well as .coupletignore", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "couplet-ignore-"));
  try {
    fs.writeFileSync(path.join(dir, ".harnessignore"), "legacy-secret.env\n");
    fs.writeFileSync(path.join(dir, ".coupletignore"), "current-secret.env\n");
    const ig = loadWorkspaceIgnore(dir);
    assert.equal(ig.ignores("legacy-secret.env"), true, "a pre-rename .harnessignore must keep applying");
    assert.equal(ig.ignores("current-secret.env"), true);
    assert.equal(ig.ignores("src/app.ts"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("truncate middle-elides text over 20000 chars", () => {
  const text = "H".repeat(9000) + "M".repeat(10000) + "T".repeat(9000);
  const out = truncate(text);
  assert.equal(out.length, 8000 + "\n…[truncated]…\n".length + 8000);
  assert.ok(out.startsWith("H".repeat(8000)));
  assert.ok(out.endsWith("T".repeat(8000)));
  assert.ok(out.includes("…[truncated]…"));
});
