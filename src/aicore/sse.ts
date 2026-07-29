import type { ToolCall } from "./types.ts";

export function splitSSEBuffer(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts.filter((p) => p.length > 0), rest };
}

export function mergeToolCallDelta(acc: ToolCall[], deltaCalls: any[]): ToolCall[] {
  for (const d of deltaCalls) {
    const idx = d.index;
    if (!acc[idx]) {
      acc[idx] = { id: d.id ?? "", type: "function", function: { name: "", arguments: "" } };
    }
    if (d.id) acc[idx].id = d.id;
    if (d.function?.name) acc[idx].function.name += d.function.name;
    if (d.function?.arguments) acc[idx].function.arguments += d.function.arguments;
  }
  return acc;
}

export function extractDataLines(event: string): string[] {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}
