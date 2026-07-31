import { test } from "node:test";
import assert from "node:assert/strict";
import { interruptedToolResults, INTERRUPTED_TOOL_RESULT } from "./toolResults.ts";
import type { ToolCall } from "../aicore/types.ts";

function call(id: string): ToolCall {
  return { id, type: "function", function: { name: "bash", arguments: "{}" } };
}

test("every unprocessed tool_call gets an interrupted placeholder", () => {
  const calls = [call("a"), call("b"), call("c")];
  const results = interruptedToolResults(calls, new Set(["a"]));
  assert.deepEqual(
    results.map((r) => r.tool_call_id),
    ["b", "c"],
  );
  for (const r of results) {
    assert.equal(r.role, "tool");
    assert.equal(r.content, INTERRUPTED_TOOL_RESULT);
  }
});

test("no placeholders when every call was processed", () => {
  const calls = [call("a"), call("b")];
  const results = interruptedToolResults(calls, new Set(["a", "b"]));
  assert.deepEqual(results, []);
});

test("all calls get placeholders when none were processed", () => {
  const calls = [call("a"), call("b")];
  const results = interruptedToolResults(calls, new Set());
  assert.equal(results.length, 2);
});
