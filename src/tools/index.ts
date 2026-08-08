import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import type { ToolSchema } from "../aicore/types.ts";
import { redactSecrets } from "../security/redactSecrets.ts";
import { getHost } from "../host.ts";

export interface ApprovalRequest {
  command: string;
  reason: string;
  severity?: "caution" | "dangerous";
}

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute: (argsJson: string, ctx: ToolContext) => Promise<string>;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(name: string, def: ToolDefinition): void {
  registry.set(name, def);
}

export function getToolSchemas(): ToolSchema[] {
  return [...registry.values()].map((d) => d.schema);
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<string> {
  const def = registry.get(name);
  if (!def) return `Unknown tool: ${name}`;
  try {
    const result = await def.execute(argsJson, ctx);
    return truncate(redactSecrets(result));
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Directories no tool may walk or search, independent of .gitignore. Both the
// current and the pre-rename data directory are listed on purpose: session
// transcripts and checkpoints store verbatim file contents and tool output, so
// a leftover .couplet/ or .harness/ from an earlier version must stay just as
// unreadable as the current one. Dropping the old name here would let the
// agent grep its own history for exactly the secrets these entries exist to
// keep out of reach.
export const HARD_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".couplet", ".harness"]);

// Shared ignore-file loader used by any tool that walks or gates access to
// workspace paths (list_dir, grep, read_file, search_replace). .coupletignore
// lets a project exclude paths from agent tool access without touching
// .gitignore (e.g. to keep secrets or generated files out of the agent's reach
// even when they're tracked in git). The legacy .harnessignore is still read,
// so a rename can't silently drop exclusions a user already relies on.
export function loadWorkspaceIgnore(root: string): ReturnType<typeof ignore> {
  const ig = ignore();
  for (const file of [".gitignore", ".coupletignore", ".harnessignore"]) {
    const filePath = path.join(root, file);
    if (fs.existsSync(filePath)) {
      ig.add(fs.readFileSync(filePath, "utf8"));
    }
  }
  return ig;
}

export function isIgnoredPath(root: string, absPath: string): boolean {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith("..")) return false;
  return loadWorkspaceIgnore(root).ignores(rel);
}

export function resolveWithinRoot(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }
  return resolved;
}

export function getWorkspaceRoot(): string {
  return getHost().workspaceRoot();
}

const MAX_LEN = 20_000;
const HALF = 8_000;

export function truncate(text: string): string {
  if (text.length <= MAX_LEN) return text;
  return text.slice(0, HALF) + "\n…[truncated]…\n" + text.slice(text.length - HALF);
}
