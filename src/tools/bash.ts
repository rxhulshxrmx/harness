import { spawn } from "node:child_process";
import * as os from "node:os";
import type * as vscodeTypes from "vscode";
import { registerTool, type ToolContext } from "./index.ts";
import type { ToolSchema } from "../aicore/types.ts";

declare function require(id: "vscode"): typeof vscodeTypes;

const READ_ONLY_EXACT = new Set([
  "git status",
  "git diff",
  "git log",
  "node --version",
  "npm ls",
  "python --version",
]);
const READ_ONLY_PREFIX_WORDS = ["ls", "dir", "cat", "type", "grep", "rg", "find"];
const AUTO_APPROVE_PREFIXES = ["npm test", "npx tsc", "pytest"];

// Conservative "does this look like more than one simple command" guard.
// Not a full shell parser — matches any operator that could chain, pipe,
// substitute, or background additional commands onto an allowlisted prefix.
const SHELL_METACHARACTER_RE = /;|&&|\|\||\||`|\$\(|\n|&/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTER_RE.test(command);
}

export function isAutoApproved(command: string): boolean {
  const trimmed = command.trim();
  if (hasShellMetacharacters(trimmed)) return false;
  if (READ_ONLY_EXACT.has(trimmed)) return true;
  const firstWord = trimmed.split(/\s+/)[0];
  if (READ_ONLY_PREFIX_WORDS.includes(firstWord)) return true;
  return AUTO_APPROVE_PREFIXES.some((p) => trimmed.startsWith(p));
}

const NEVER_AUTO_WORDS = ["rm ", "del ", "git push", "git reset", "curl ", "wget ", "sudo "];

export function isNeverAutoApproved(command: string): boolean {
  const trimmed = command.trim();
  if (
    NEVER_AUTO_WORDS.some((w) => {
      const word = w.trim();
      return trimmed.startsWith(w) || new RegExp(`(^|[^a-zA-Z0-9_])${word}`).test(trimmed);
    })
  )
    return true;
  if (/[>]/.test(trimmed)) return true;
  if (/\bsudo\b/.test(trimmed)) return true;
  if (/(^|\s)\/(?!$)/.test(trimmed) && !trimmed.startsWith("git ")) return true;
  return false;
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command in the workspace root.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", description: "default 60000, max 300000" },
      },
      required: ["command"],
    },
  },
};

registerTool("bash", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const command: string = args.command;
    const timeoutMs = Math.min(300_000, args.timeout_ms ?? 60_000);

    const vscode = require("vscode");
    const approvalMode = vscode.workspace.getConfiguration("forge").get<string>("approvalMode", "ask");

    const autoOk = approvalMode === "auto" && isAutoApproved(command) && !isNeverAutoApproved(command);
    if (!autoOk) {
      const approved = await ctx.requestApproval(command);
      if (!approved) return "User denied this command.";
    }

    return new Promise<string>((resolve) => {
      const isWin = os.platform() === "win32";
      const child = spawn(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd: ctx.workspaceRoot,
      });

      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(output + `\n[killed: exceeded ${timeoutMs}ms timeout]`);
      }, timeoutMs);

      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(output + `\n[exit code ${code}]`);
      });
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        child.kill();
        resolve(output + "\n[aborted]");
      });
    });
  },
});
