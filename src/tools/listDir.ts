import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { registerTool, resolveWithinRoot, getWorkspaceRoot, type ToolContext } from "./index.ts";
import type { ToolSchema } from "../aicore/types.ts";

const HARD_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".forge"]);
const MAX_ENTRIES = 500;

function loadIgnorer(root: string) {
  const ig = ignore();
  const gitignorePath = path.join(root, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  return ig;
}

export function buildTree(root: string, startAbs: string, depth: number, ig: ReturnType<typeof ignore>): string {
  const lines: string[] = [];
  let count = 0;

  function walk(dirAbs: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth || count >= MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (count >= MAX_ENTRIES) return;
      if (HARD_EXCLUDES.has(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(root, abs);
      if (ig.ignores(rel)) continue;
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      count++;
      if (entry.isDirectory()) walk(abs, currentDepth + 1, prefix + "  ");
    }
  }

  walk(startAbs, 1, "");
  return lines.length ? lines.join("\n") : "(empty)";
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "list_dir",
    description: "List files and directories as an indented tree, respecting .gitignore.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "default '.'" },
        depth: { type: "integer", description: "default 2, max 4" },
      },
    },
  },
};

registerTool("list_dir", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson || "{}");
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.path ?? ".");
    const depth = Math.min(4, args.depth ?? 2);
    const ig = loadIgnorer(ctx.workspaceRoot);
    return buildTree(ctx.workspaceRoot, abs, depth, ig);
  },
});

export { getWorkspaceRoot };
