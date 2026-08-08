import { setHost } from "../host.ts";
import { CliHost } from "./cliHost.ts";
import { createSession } from "../state/session.ts";
import { runTurn, type UiPort } from "../agent/loop.ts";
import type { ApprovalRequest } from "../tools/index.ts";
import "../tools/readFile.ts";
import "../tools/listDir.ts";
import "../tools/grep.ts";
import "../tools/searchReplace.ts";
import "../tools/bash.ts";

interface Args {
  instruction: string;
  workspace: string;
  skipPermissions: boolean;
}

const USAGE = `Usage: couplet-cli --instruction "<task>" [--workspace <dir>] [--dangerously-skip-permissions]

Runs Couplet's agent loop headlessly against a workspace, for use in
non-interactive contexts (CI, benchmark harnesses like Terminal-Bench and
SWE-bench). Credentials and settings come from environment variables:

  COUPLET_CLIENT_ID, COUPLET_CLIENT_SECRET, COUPLET_AI_CORE_BASE_URL,
  COUPLET_TOKEN_URL, COUPLET_RESOURCE_GROUP (default "default"),
  COUPLET_API_VERSION (default "2024-10-21"), COUPLET_MODEL,
  COUPLET_DEPLOYMENT_ID (optional pin), COUPLET_APPROVAL_MODE ("ask"|"auto"),
  COUPLET_CONTEXT_BUDGET (default 100000)

Without --dangerously-skip-permissions, any command the approval policy would
normally prompt for is denied outright — there is no one to answer the prompt.
That flag is only appropriate inside a disposable, sandboxed environment.`;

function parseArgs(argv: string[]): Args {
  let instruction: string | undefined;
  let workspace = process.cwd();
  let skipPermissions = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--instruction":
      case "-i":
        instruction = argv[++i];
        break;
      case "--workspace":
      case "-w":
        workspace = argv[++i];
        break;
      case "--dangerously-skip-permissions":
        skipPermissions = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (instruction === undefined && !arg.startsWith("-")) instruction = arg;
    }
  }

  if (!instruction) {
    console.error(USAGE);
    process.exit(2);
  }
  return { instruction, workspace, skipPermissions };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const host = new CliHost(args.workspace, process.env);
  setHost(host);

  const model = host.getConfig("model", "");
  const session = createSession(args.instruction, model);

  let exitCode = 0;
  const ui: UiPort = {
    streamAssistantText(delta) {
      process.stdout.write(delta);
    },
    messagesChanged() {},
    async requestApproval(request: ApprovalRequest) {
      if (args.skipPermissions) return true;
      process.stderr.write(
        `\n[denied — no approver in headless mode; pass --dangerously-skip-permissions to run unattended] ${request.command} (${request.reason})\n`,
      );
      return false;
    },
    showTurnDiff(files) {
      if (files.length) process.stderr.write(`\n[touched files] ${files.join(", ")}\n`);
    },
    showError(message) {
      process.stderr.write(`\n[error] ${message}\n`);
      exitCode = 1;
    },
  };

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  await runTurn(session, args.instruction, ui, controller.signal);
  process.stdout.write("\n");
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
