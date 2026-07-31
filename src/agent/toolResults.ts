import type { Message, ToolCall } from "../aicore/types.ts";

// No `vscode` import — kept separate from loop.ts (which does import vscode)
// so this pure logic stays unit-testable under plain `node --test`, the same
// split used for aicore/sse.ts vs. aicore/client.ts.

export const INTERRUPTED_TOOL_RESULT =
  "[INTERRUPTED] This tool call did not complete (the turn was stopped or an error occurred). Do not assume it succeeded or failed — verify current state before retrying.";

// Given the full set of tool_calls an assistant message asked for and the
// ids that actually got a real result, produces placeholder tool-result
// messages for the rest so every tool_call ends up with a matching message.
export function interruptedToolResults(toolCalls: ToolCall[], processedCallIds: Set<string>): Message[] {
  return toolCalls
    .filter((call) => !processedCallIds.has(call.id))
    .map((call) => ({ role: "tool" as const, tool_call_id: call.id, content: INTERRUPTED_TOOL_RESULT }));
}
