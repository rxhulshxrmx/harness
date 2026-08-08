import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolveShell } from "./shell.ts";
import { registerTool, type ToolContext } from "./index.ts";
import { diffTracker } from "../state/diffTracker.ts";
import { classifyCommand, matchesAlwaysAllowed } from "./commandPolicy.ts";
import { getHost, ALWAYS_ALLOW_KEY } from "../host.ts";
import type { ToolSchema } from "../aicore/types.ts";

// Resolving the shell walks PATH, so do it once rather than per command. The
// system prompt reads the same value, so what the model is told matches what
// actually runs.
let cachedShell: ReturnType<typeof resolveShell> | null = null;
export function getShell() {
  cachedShell ??= resolveShell(os.platform(), process.env, fs.existsSync);
  return cachedShell;
}

export { ALWAYS_ALLOW_KEY };

function recordGitTouchedFiles(workspaceRoot: string) {
  try {
    const out = execSync("git diff --name-only", { cwd: workspaceRoot, encoding: "utf8" });
    for (const file of out.split("\n").filter(Boolean)) {
      diffTracker.snapshot(file, undefined);
    }
  } catch {
    // not a git repo, or git unavailable — silently skip
  }
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

    const host = getHost();
    const approvalMode = host.getConfig<string>("approvalMode", "ask");

    const classification = classifyCommand(command);
    const autoOk =
      (approvalMode === "auto" && classification.decision === "allow") ||
      // Standing approval the user granted from a previous prompt. Independent
      // of approvalMode: it is a decision about this command, not about how
      // trusting to be in general.
      matchesAlwaysAllowed(command, host.getAlwaysAllowed());
    if (!autoOk) {
      const approved = await ctx.requestApproval({
        command,
        reason: classification.reason,
        severity: classification.severity,
      });
      if (!approved) return "User denied this command.";
    }

    return new Promise<string>((resolve) => {
      const child = spawn(command, {
        shell: getShell().spawnShell,
        cwd: ctx.workspaceRoot,
      });

      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        recordGitTouchedFiles(ctx.workspaceRoot);
        resolve(output + `\n[killed: exceeded ${timeoutMs}ms timeout]`);
      }, timeoutMs);

      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        recordGitTouchedFiles(ctx.workspaceRoot);
        resolve(output + `\n[exit code ${code}]`);
      });
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        child.kill();
        recordGitTouchedFiles(ctx.workspaceRoot);
        resolve(output + "\n[aborted]");
      });
    });
  },
});
