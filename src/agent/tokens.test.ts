import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "./tokens.ts";

test("estimateTokens is roughly chars/4 across all messages", () => {
  const messages = [
    { role: "user" as const, content: "a".repeat(400) },
    { role: "assistant" as const, content: "b".repeat(400), tool_calls: undefined },
  ];
  assert.equal(estimateTokens(messages), 200);
});

test("estimateTokens counts tool_calls argument text", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [{ id: "1", type: "function" as const, function: { name: "grep", arguments: "x".repeat(40) } }],
    },
  ];
  assert.equal(estimateTokens(messages), 10);
});
