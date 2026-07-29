import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWithinRoot, truncate } from "./index.ts";

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

test("truncate middle-elides text over 20000 chars", () => {
  const text = "H".repeat(9000) + "M".repeat(10000) + "T".repeat(9000);
  const out = truncate(text);
  assert.equal(out.length, 8000 + "\n…[truncated]…\n".length + 8000);
  assert.ok(out.startsWith("H".repeat(8000)));
  assert.ok(out.endsWith("T".repeat(8000)));
  assert.ok(out.includes("…[truncated]…"));
});
