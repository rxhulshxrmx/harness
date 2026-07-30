import * as path from "node:path";
import type * as vscodeTypes from "vscode";
import type { ToolSchema } from "../aicore/types.ts";

declare function require(id: "vscode"): typeof vscodeTypes;

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  requestApproval: (command: string) => Promise<boolean>;
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
    return truncate(result);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function resolveWithinRoot(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }
  return resolved;
}

// `vscode` is only resolvable inside a live extension host, not under plain
// `node --test` (there is no "vscode" package in node_modules). Referencing
// it lazily via `require` inside the function body — instead of a top-level
// `import` — keeps this module's import graph loadable for unit tests that
// only exercise the pure helpers below (they never call this function).
// esbuild bundles this to CJS with "vscode" marked external, so the real
// extension still gets a plain `require("vscode")` served by the host.
export function getWorkspaceRoot(): string {
  const vscode = require("vscode");
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error("No workspace folder open.");
  return root;
}

const MAX_LEN = 20_000;
const HALF = 8_000;

export function truncate(text: string): string {
  if (text.length <= MAX_LEN) return text;
  return text.slice(0, HALF) + "\n…[truncated]…\n" + text.slice(text.length - HALF);
}
