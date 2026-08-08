// The agent loop and tools run in two hosts today: inside the VS Code
// extension (VscodeHost, in vscodeHost.ts) and, headlessly, from the CLI
// entrypoint (CliHost, in cli/cliHost.ts) used for benchmark harnesses like
// Terminal-Bench and SWE-bench. Everything reusable between the two goes
// through this interface instead of touching `vscode` or `process.env`
// directly, so the agent/tools/aicore modules stay loadable — and testable —
// outside an extension host.
export interface Host {
  /** Absolute path to the root the agent may read, search, and edit within. */
  workspaceRoot(): string;

  /** A `couplet.*` setting, e.g. `getConfig("approvalMode", "ask")`. */
  getConfig<T>(key: string, defaultValue: T): T;

  /** A secret value, e.g. the SAP AI Core client secret. */
  getSecret(key: string): Promise<string | undefined>;

  /** Standing command-approval patterns in force (see tools/commandPolicy.ts). */
  getAlwaysAllowed(): string[];

  /** Writes a file's full contents, creating it (and its directory) if needed. */
  writeFile(absPath: string, content: string, opts: { create: boolean }): Promise<void>;

  /** Best-effort UI nicety: bring the edited file into view. No-op where there is no editor. */
  revealEdit(absPath: string, content: string, needle?: string): Promise<void>;
}

export const ALWAYS_ALLOW_KEY = "couplet.alwaysAllow";

let current: Host | undefined;

export function setHost(host: Host): void {
  current = host;
}

export function getHost(): Host {
  if (!current) throw new Error("No host configured — setHost() must be called during startup.");
  return current;
}
