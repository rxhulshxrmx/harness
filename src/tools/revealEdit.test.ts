import { test } from "node:test";
import assert from "node:assert/strict";
import { revealOffset } from "./revealEdit.ts";

test("scrolls to the start of the newly written text", () => {
  const content = "line one\nline two\nCHANGED\nline four";
  assert.equal(revealOffset(content, "CHANGED"), content.indexOf("CHANGED"));
});

test("falls back to the top when the new text is not present", () => {
  // A pure deletion writes an empty new_string, and reflowed content may not
  // contain the replacement verbatim; neither should throw or scroll wildly.
  assert.equal(revealOffset("abc", ""), 0);
  assert.equal(revealOffset("abc", undefined), 0);
  assert.equal(revealOffset("abc", "not in here"), 0);
});
