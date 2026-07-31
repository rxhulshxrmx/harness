import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiffTracker } from "./diffTracker.ts";

test("snapshot only records the first write to a file per turn", () => {
  const dt = createDiffTracker();
  dt.beginTurn();
  dt.snapshot("a.ts", "original");
  dt.snapshot("a.ts", "intermediate-should-be-ignored");
  assert.equal(dt.getSnapshot("a.ts"), "original");
});

test("endTurn returns all touched files and beginTurn clears them", () => {
  const dt = createDiffTracker();
  dt.beginTurn();
  dt.snapshot("a.ts", "x");
  dt.snapshot("b.ts", null);
  assert.deepEqual(dt.endTurn().sort(), ["a.ts", "b.ts"]);
  dt.beginTurn();
  assert.deepEqual(dt.endTurn(), []);
});

test("getSnapshot distinguishes untouched (undefined) from newly-created (null)", () => {
  const dt = createDiffTracker();
  dt.beginTurn();
  dt.snapshot("new.ts", null);
  assert.equal(dt.getSnapshot("new.ts"), null);
  assert.equal(dt.getSnapshot("never-touched.ts"), undefined);
});
