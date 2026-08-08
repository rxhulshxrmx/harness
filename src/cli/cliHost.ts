import * as fs from "node:fs";
import * as path from "node:path";
import type { Host } from "../host.ts";
import { CLIENT_SECRET_KEY } from "../aicore/config.ts";

// Maps each `couplet.*` setting read through Host.getConfig to the
// environment variable a headless run (e.g. a Terminal-Bench or SWE-bench
// container) sets instead of VS Code settings.json.
const ENV_VAR_NAMES: Record<string, string> = {
  clientId: "COUPLET_CLIENT_ID",
  aiCoreBaseUrl: "COUPLET_AI_CORE_BASE_URL",
  tokenUrl: "COUPLET_TOKEN_URL",
  resourceGroup: "COUPLET_RESOURCE_GROUP",
  apiVersion: "COUPLET_API_VERSION",
  model: "COUPLET_MODEL",
  deploymentId: "COUPLET_DEPLOYMENT_ID",
  approvalMode: "COUPLET_APPROVAL_MODE",
  contextBudget: "COUPLET_CONTEXT_BUDGET",
};

/**
 * Host implementation for the headless CLI (src/cli/main.ts). There is no
 * editor, no SecretStorage, and no per-workspace standing-approval grants —
 * credentials and settings come from environment variables, edits go straight
 * to disk, and always-allow is always empty (the CLI's own
 * --dangerously-skip-permissions flag is the equivalent for unattended runs,
 * handled at the UiPort level in main.ts rather than here).
 */
export class CliHost implements Host {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(root: string, env: NodeJS.ProcessEnv) {
    this.root = root;
    this.env = env;
  }

  workspaceRoot(): string {
    return this.root;
  }

  getConfig<T>(key: string, defaultValue: T): T {
    const envName = ENV_VAR_NAMES[key];
    const raw = envName ? this.env[envName] : undefined;
    if (raw === undefined || raw === "") return defaultValue;
    if (typeof defaultValue === "number") return Number(raw) as unknown as T;
    if (typeof defaultValue === "boolean") return (raw === "true" || raw === "1") as unknown as T;
    return raw as unknown as T;
  }

  async getSecret(key: string): Promise<string | undefined> {
    if (key === CLIENT_SECRET_KEY) return this.env["COUPLET_CLIENT_SECRET"];
    return undefined;
  }

  getAlwaysAllowed(): string[] {
    return [];
  }

  async writeFile(absPath: string, content: string, opts: { create: boolean }): Promise<void> {
    if (opts.create) fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
  }

  async revealEdit(): Promise<void> {
    // No editor in headless mode.
  }
}
