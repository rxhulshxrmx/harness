import * as path from "node:path";

export type ShellFamily = "posix" | "powershell";

export interface ShellInfo {
  /** Value for child_process.spawn's `shell` option. `true` means "the platform default". */
  spawnShell: string | true;
  /** Shown to the model so it knows what syntax it is writing for. */
  label: string;
  family: ShellFamily;
  /** Windows PowerShell 5.1 has no `&&` / `||`; pwsh 7+ and POSIX shells do. */
  supportsAndOr: boolean;
}

/**
 * Resolves an executable against PATH using Windows rules. Injected `exists`
 * keeps this testable without a Windows machine or a real filesystem.
 */
export function findOnWindowsPath(
  exe: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string | null {
  // Windows environment lookups are case-insensitive, but process.env on a
  // non-Windows host is not, so accept either spelling.
  const raw = env.PATH ?? env.Path ?? "";
  for (const dir of raw.split(";")) {
    const trimmed = dir.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    const full = path.win32.join(trimmed, exe);
    if (exists(full)) return full;
  }
  return null;
}

/**
 * Picks the shell commands actually run in, and reports what it supports.
 *
 * On Windows this prefers pwsh.exe (PowerShell 7+) over powershell.exe
 * (Windows PowerShell 5.1). The difference matters: 5.1 has no `&&` or `||`,
 * so a model writing ordinary `cmd1 && cmd2` gets a parse error and retries —
 * each retry re-sending the whole conversation.
 */
export function resolveShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): ShellInfo {
  if (platform !== "win32") {
    return {
      spawnShell: true,
      label: env.SHELL ?? "/bin/bash",
      family: "posix",
      supportsAndOr: true,
    };
  }
  const pwsh = findOnWindowsPath("pwsh.exe", env, exists);
  if (pwsh) {
    return {
      spawnShell: pwsh,
      label: "PowerShell 7+ (pwsh.exe)",
      family: "powershell",
      supportsAndOr: true,
    };
  }
  return {
    spawnShell: "powershell.exe",
    label: "Windows PowerShell 5.1 (powershell.exe)",
    family: "powershell",
    supportsAndOr: false,
  };
}

/**
 * Shell-specific rules for the system prompt. Returns "" for POSIX shells,
 * whose syntax the model already defaults to — the text is only worth its
 * tokens where the default would be wrong.
 */
export function shellGuidance(info: ShellInfo): string {
  if (info.family !== "powershell") return "";
  const chaining = info.supportsAndOr
    ? `- Chain steps with ";" or "&&".`
    : `- This shell has NO "&&" and NO "||" — they are parse errors, not failures you can\n  retry. Send one command per bash call, or separate steps with ";". When a step\n  must only run if the previous one succeeded:\n  step1; if ($LASTEXITCODE -eq 0) { step2 }`;
  return `
Shell syntax — this is PowerShell, not bash:
${chaining}
- Single-quote any path containing spaces: 'C:\\Program Files\\nodejs\\node.exe'.
- Bash forms that fail here: "export VAR=x" (use "$env:VAR='x'"), "ls -la" (use
  "Get-ChildItem"), "rm -rf x" (use "Remove-Item -Recurse -Force x"), "which x"
  (use "Get-Command x").
- Prefer the read_file, list_dir, grep and search_replace tools over shell
  commands. They behave identically on every platform, need no quoting, and are
  more likely to run without an approval prompt.
`;
}
