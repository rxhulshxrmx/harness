import { test } from "node:test";
import assert from "node:assert/strict";
import { planReplacement } from "./searchReplace.ts";

test("empty old_string on non-existent file creates it", () => {
  const plan = planReplacement(null, "", "hello", false);
  assert.equal(plan.kind, "create");
  assert.equal(plan.content, "hello");
});

test("zero matches is an error", () => {
  const plan = planReplacement("const a = 1;", "const b", "const c", false);
  assert.equal(plan.kind, "error");
  assert.match(plan.error!, /No match for old_string/);
});

test("multiple matches without replace_all is an error", () => {
  const plan = planReplacement("x\nx\nx", "x", "y", false);
  assert.equal(plan.kind, "error");
  assert.match(plan.error!, /matched 3 times/);
});

test("exactly one match replaces", () => {
  const plan = planReplacement("const a = 1;\nconst b = 2;", "const a = 1;", "const a = 2;", false);
  assert.equal(plan.kind, "replace");
  assert.equal(plan.content, "const a = 2;\nconst b = 2;");
});

test("replace_all replaces every occurrence", () => {
  const plan = planReplacement("x\nx\nx", "x", "y", true);
  assert.equal(plan.kind, "replace");
  assert.equal(plan.content, "y\ny\ny");
});
