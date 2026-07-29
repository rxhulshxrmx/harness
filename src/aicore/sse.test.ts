import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSSEBuffer, mergeToolCallDelta } from "./sse.ts";

test("splitSSEBuffer splits complete events and keeps the remainder", () => {
  const buf = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: partial';
  const { events, rest } = splitSSEBuffer(buf);
  assert.deepEqual(events, ['data: {"a":1}', 'data: {"b":2}']);
  assert.equal(rest, "data: partial");
});

test("mergeToolCallDelta accumulates fragments by index", () => {
  let acc: any[] = [];
  acc = mergeToolCallDelta(acc, [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"file' } }]);
  acc = mergeToolCallDelta(acc, [{ index: 0, function: { arguments: '_path":"a.ts"}' } }]);
  assert.equal(acc[0].id, "call_1");
  assert.equal(acc[0].function.name, "read_file");
  assert.equal(acc[0].function.arguments, '{"file_path":"a.ts"}');
});

test("mergeToolCallDelta handles two concurrent tool calls", () => {
  let acc: any[] = [];
  acc = mergeToolCallDelta(acc, [
    { index: 0, id: "call_1", function: { name: "read_file", arguments: "{}" } },
    { index: 1, id: "call_2", function: { name: "grep", arguments: "{}" } },
  ]);
  assert.equal(acc.length, 2);
  assert.equal(acc[1].function.name, "grep");
});
