import type * as vscodeTypes from "vscode";
import type { Session } from "./session.ts";
import { getCheckpoint, deleteCheckpointsFrom } from "./checkpoints.ts";
import { rewriteStoreMessages } from "./store.ts";
import { resolveWithinRoot } from "../tools/index.ts";

declare function require(id: "vscode"): typeof vscodeTypes;

export interface RewindResult {
  restored: string[];
  unrestorable: string[];
  // Paths in the checkpoint that resolved outside the workspace and were
  // refused. Never expected from a checkpoint this extension wrote; surfaced
  // rather than silently dropped because it means the file was tampered with.
  rejected: string[];
}

// Restores every file touched by `turnIndex` back to its pre-turn content
// (or deletes it, if the turn created it), then truncates the session's
// messages/JSONL log back to right before that turn — undoing the turn's
// chat and file changes together. Requires a `vscode` host; not unit-tested,
// verified manually via the Extension Development Host (same convention as
// searchReplace.ts's execute()).
export async function rewindToTurn(workspaceRoot: string, session: Session, turnIndex: number): Promise<RewindResult | null> {
  const checkpoint = getCheckpoint(workspaceRoot, session.id, turnIndex);
  if (!checkpoint) return null;

  const vscode = require("vscode");
  const restored: string[] = [];
  const rejected: string[] = [];
  for (const [file, before] of Object.entries(checkpoint.files)) {
    // Same containment rule every tool goes through. A checkpoint is read
    // from inside the workspace, so its keys are untrusted input: without
    // this, a "../../.." key would let an opened repository overwrite or
    // delete files anywhere the editor can write.
    let abs: string;
    try {
      abs = resolveWithinRoot(workspaceRoot, file);
    } catch {
      rejected.push(file);
      continue;
    }
    const uri = vscode.Uri.file(abs);
    const edit = new vscode.WorkspaceEdit();
    if (before === null) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(edit);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, fullRange, before);
      await vscode.workspace.applyEdit(edit);
      const saved = await vscode.workspace.openTextDocument(uri);
      await saved.save();
    }
    restored.push(file);
  }

  session.messages = session.messages.slice(0, checkpoint.messageCountBefore);
  if (session.filePath) rewriteStoreMessages(session.filePath, session.messages);
  deleteCheckpointsFrom(workspaceRoot, session.id, turnIndex);

  return { restored, unrestorable: checkpoint.unrestorable, rejected };
}
