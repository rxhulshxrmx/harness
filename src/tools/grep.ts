import * as fs from "node:fs";
import * as path from "node:path";
import { registerTool, resolveWithinRoot, loadWorkspaceIgnore, HARD_EXCLUDES, type ToolContext } from "./index.ts";
import type { ToolSchema } from "../aicore/types.ts";
const MAX_FILE_BYTES = 1_000_000;

export function searchInText(content: string, pattern: RegExp, filePath: string, maxResults: number): string[] {
  const hits: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
    if (pattern.test(lines[i])) {
      hits.push(`${filePath}:${i + 1}: ${lines[i]}`);
    }
    pattern.lastIndex = 0;
  }
  return hits;
}

function matchesGlob(rel: string, glob?: string): boolean {
  if (!glob) return true;
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".+")
        .replace(/\*/g, "[^/]*") +
      "$",
  );
  return re.test(rel);
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents by regex across the workspace, respecting .gitignore/.coupletignore.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string", description: "e.g. '**/*.ts'" },
        max_results: { type: "integer", description: "default 100" },
      },
      required: ["pattern"],
    },
  },
};

registerTool("grep", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const maxResults = args.max_results ?? 100;
    const re = new RegExp(args.pattern);
    const ig = loadWorkspaceIgnore(ctx.workspaceRoot);

    const results: string[] = [];

    function walk(dirAbs: string) {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (HARD_EXCLUDES.has(entry.name)) continue;
        const abs = path.join(dirAbs, entry.name);
        const rel = path.relative(ctx.workspaceRoot, abs);
        if (ig.ignores(rel)) continue;
        if (entry.isDirectory()) {
          walk(abs);
        } else if (matchesGlob(rel, args.glob)) {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = fs.readFileSync(abs, "utf8").toString();
          results.push(...searchInText(content, re, rel, maxResults - results.length));
        }
      }
    }

    walk(resolveWithinRoot(ctx.workspaceRoot, "."));
    return results.length ? results.join("\n") : "No matches.";
  },
});
