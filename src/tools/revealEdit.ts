import type * as vscodeTypes from "vscode";

declare function require(id: "vscode"): typeof vscodeTypes;

/**
 * Where to scroll after an edit: the start of the text just written, so the
 * user's eye lands on the change rather than on line 1 of the file. Falls back
 * to the top when the new text cannot be located (a pure deletion, or content
 * the replacement reflowed).
 */
export function revealOffset(content: string, needle: string | undefined): number {
  if (!needle) return 0;
  const idx = content.indexOf(needle);
  return idx >= 0 ? idx : 0;
}

/**
 * Brings an edited file into the editor so changes are visible as the agent
 * makes them. Opened with preserveFocus so the chat keeps keyboard focus — an
 * agent doing ten edits would otherwise steal focus ten times mid-sentence —
 * and as a preview tab so a long run does not bury the editor in tabs.
 */
export async function revealEdit(uri: vscodeTypes.Uri, content: string, needle?: string): Promise<void> {
  const vscode = require("vscode");
  if (!vscode.workspace.getConfiguration("couplet").get<boolean>("revealEdits", true)) return;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Active,
    });
    const pos = doc.positionAt(revealOffset(content, needle));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    // Revealing is a convenience; never fail an applied edit because the
    // editor could not show it.
  }
}
