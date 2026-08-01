import * as fs from "node:fs";
import * as path from "node:path";

// Per-turn rewind checkpoints: for every turn, records the pre-turn content
// of every file touched (null = file didn't exist yet, i.e. it was
// created), plus enough session state to truncate the chat back to right
// before that turn. Persisted to .harness/checkpoints/<session-id>/ so
// rewind survives a reload, capped to the most recent MAX_CHECKPOINTS turns.

export interface Checkpoint {
  turnIndex: number;
  messageCountBefore: number;
  userText: string;
  files: Record<string, string | null>;
  // Files touched this turn that a shell command modified without going
  // through a tool that snapshots exact prior content — can't be restored.
  unrestorable: string[];
}

const MAX_CHECKPOINTS = 20;

// Both of these end up interpolated into a filesystem path, and both can
// reach here from outside this module — the session id is derived by parsing
// a filename found in the workspace (see loadSession), and the turn index
// arrives as a webview message. Neither is trusted enough to concatenate
// into a path unchecked.
function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Unsafe session id: ${sessionId}`);
  }
}

function assertSafeTurnIndex(turnIndex: number): void {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error(`Invalid turn index: ${turnIndex}`);
  }
}

function checkpointsDir(workspaceRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(workspaceRoot, ".harness", "checkpoints", sessionId);
}

function checkpointPath(workspaceRoot: string, sessionId: string, turnIndex: number): string {
  assertSafeTurnIndex(turnIndex);
  return path.join(checkpointsDir(workspaceRoot, sessionId), `checkpoint-${turnIndex}.json`);
}

function turnIndexFromFilename(filename: string): number | null {
  const match = filename.match(/^checkpoint-(\d+)\.json$/);
  return match ? Number(match[1]) : null;
}

export function saveCheckpoint(workspaceRoot: string, sessionId: string, checkpoint: Checkpoint): void {
  const dir = checkpointsDir(workspaceRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(checkpointPath(workspaceRoot, sessionId, checkpoint.turnIndex), JSON.stringify(checkpoint));
  evictOldest(dir);
}

function evictOldest(dir: string): void {
  const indexed = fs
    .readdirSync(dir)
    .map((f) => ({ f, n: turnIndexFromFilename(f) }))
    .filter((x): x is { f: string; n: number } => x.n !== null)
    .sort((a, b) => a.n - b.n);
  const excess = indexed.length - MAX_CHECKPOINTS;
  if (excess <= 0) return;
  for (const { f } of indexed.slice(0, excess)) fs.rmSync(path.join(dir, f));
}

// A checkpoint file lives inside the workspace, so its contents are only as
// trustworthy as the repository that was opened — a cloned repo can ship a
// hand-written .harness/checkpoints/ tree. Validate the shape rather than
// casting, so rewind never iterates attacker-shaped data. (Path containment
// for the individual file keys is enforced separately, in rewind.ts.)
function parseCheckpoint(raw: unknown): Checkpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!Number.isInteger(c.turnIndex) || (c.turnIndex as number) < 0) return null;
  if (!Number.isInteger(c.messageCountBefore) || (c.messageCountBefore as number) < 0) return null;
  if (typeof c.userText !== "string") return null;
  if (typeof c.files !== "object" || c.files === null || Array.isArray(c.files)) return null;
  for (const value of Object.values(c.files as Record<string, unknown>)) {
    if (value !== null && typeof value !== "string") return null;
  }
  if (!Array.isArray(c.unrestorable) || c.unrestorable.some((f) => typeof f !== "string")) return null;
  return c as unknown as Checkpoint;
}

export function getCheckpoint(workspaceRoot: string, sessionId: string, turnIndex: number): Checkpoint | null {
  const filePath = checkpointPath(workspaceRoot, sessionId, turnIndex);
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseCheckpoint(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function listCheckpoints(workspaceRoot: string, sessionId: string): Checkpoint[] {
  const dir = checkpointsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => turnIndexFromFilename(f) !== null)
    .map((f) => {
      try {
        return parseCheckpoint(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      } catch {
        return null;
      }
    })
    .filter((c): c is Checkpoint => c !== null)
    .sort((a, b) => a.turnIndex - b.turnIndex);
}

// Removes checkpoint fromTurnIndex and every later one — called after a
// rewind, since those turns no longer exist in the truncated history.
export function deleteCheckpointsFrom(workspaceRoot: string, sessionId: string, fromTurnIndex: number): void {
  assertSafeTurnIndex(fromTurnIndex);
  const dir = checkpointsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const n = turnIndexFromFilename(f);
    if (n !== null && n >= fromTurnIndex) fs.rmSync(path.join(dir, f));
  }
}
