import type { Message } from "../aicore/types.ts";

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const call of m.tool_calls ?? []) {
      chars += call.function.arguments.length;
    }
  }
  return Math.ceil(chars / 4);
}
