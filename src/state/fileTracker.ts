import * as fs from "node:fs";

// Tracks the on-disk mtime of files the agent has read via read_file, so
// search_replace can detect when a file changed on disk *after* the agent
// last saw it — even if the exact-string match it's about to apply would
// still succeed. search_replace already re-reads the file fresh at execute
// time, so a literal mismatch is already caught; this catches the case where
// the surrounding content changed (by the user, or by an earlier bash call)
// without the model's mental picture of the file being refreshed.

const lastReadMtime = new Map<string, number>();

function currentMtime(absPath: string): number | null {
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
}

export function recordRead(absPath: string): void {
  const mtime = currentMtime(absPath);
  if (mtime !== null) lastReadMtime.set(absPath, mtime);
}

export function isStale(absPath: string): boolean {
  const recorded = lastReadMtime.get(absPath);
  if (recorded === undefined) return true;
  const current = currentMtime(absPath);
  if (current === null) return true;
  return current !== recorded;
}

export function clearTracked(): void {
  lastReadMtime.clear();
}
