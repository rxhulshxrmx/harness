import * as fs from "node:fs";
import { registerTool, resolveWithinRoot, isIgnoredPath, type ToolContext } from "./index.ts";
import { recordRead } from "../state/fileTracker.ts";
import type { ToolSchema } from "../aicore/types.ts";

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

export function formatFileContent(absPath: string, offset: number, limit: number): string {
  const buf = fs.readFileSync(absPath);
  if (isBinary(buf)) return `[binary file, ${buf.length} bytes]`;

  const allLines = buf.toString("utf8").split("\n");
  const total = allLines.length;
  const start = Math.max(1, offset);
  const end = Math.min(total, start + limit - 1);
  const window = allLines.slice(start - 1, end);

  const width = Math.max(2, String(total).length);
  const body = window.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join("\n");

  if (start === 1 && end === total) return body;
  return `${body}\n[showing lines ${start}-${end} of ${total}]`;
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns content with line numbers. Use offset/limit for large files.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "integer", description: "1-based first line, default 1" },
        limit: { type: "integer", description: "max lines, default 400" },
      },
      required: ["file_path"],
    },
  },
};

registerTool("read_file", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.file_path);
    if (isIgnoredPath(ctx.workspaceRoot, abs)) {
      return `Error: path is excluded by .gitignore/.coupletignore (${args.file_path})`;
    }
    const content = formatFileContent(abs, args.offset ?? 1, args.limit ?? 400);
    recordRead(abs);
    return content;
  },
});
