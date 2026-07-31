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

function checkpointsDir(workspaceRoot: string, sessionId: string): string {
  return path.join(workspaceRoot, ".harness", "checkpoints", sessionId);
}

function checkpointPath(workspaceRoot: string, sessionId: string, turnIndex: number): string {
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

export function getCheckpoint(workspaceRoot: string, sessionId: string, turnIndex: number): Checkpoint | null {
  const filePath = checkpointPath(workspaceRoot, sessionId, turnIndex);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function listCheckpoints(workspaceRoot: string, sessionId: string): Checkpoint[] {
  const dir = checkpointsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => turnIndexFromFilename(f) !== null)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Checkpoint)
    .sort((a, b) => a.turnIndex - b.turnIndex);
}

// Removes checkpoint fromTurnIndex and every later one — called after a
// rewind, since those turns no longer exist in the truncated history.
export function deleteCheckpointsFrom(workspaceRoot: string, sessionId: string, fromTurnIndex: number): void {
  const dir = checkpointsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const n = turnIndexFromFilename(f);
    if (n !== null && n >= fromTurnIndex) fs.rmSync(path.join(dir, f));
  }
}
