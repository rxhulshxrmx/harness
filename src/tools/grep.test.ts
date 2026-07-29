import { test } from "node:test";
import assert from "node:assert/strict";
import { searchInText } from "./grep.ts";

test("searchInText returns path:line:text for each match", () => {
  const content = "foo\nbar getToken\nbaz\ngetToken again";
  const hits = searchInText(content, /getToken/, "src/a.ts", 100);
  assert.deepEqual(hits, ["src/a.ts:2: bar getToken", "src/a.ts:4: getToken again"]);
});

test("searchInText stops at maxResults", () => {
  const content = "x\nx\nx\nx";
  const hits = searchInText(content, /x/, "f.ts", 2);
  assert.equal(hits.length, 2);
});
