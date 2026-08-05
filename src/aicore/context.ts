import type * as vscodeTypes from "vscode";

// Small singleton holding the extension context, set once in activate().
// Needed so aicore/client.ts (which only ever did synchronous
// vscode.workspace.getConfiguration() reads before) can also reach
// SecretStorage for the SAP AI Core client secret, without threading a
// context parameter through every call in the chat()/tool-loop chain.
let extensionContext: vscodeTypes.ExtensionContext | undefined;

export function setExtensionContext(context: vscodeTypes.ExtensionContext): void {
  extensionContext = context;
}

export function getSecrets(): vscodeTypes.SecretStorage {
  if (!extensionContext) throw new Error("Extension context not initialized.");
  return extensionContext.secrets;
}

/**
 * Per-workspace storage owned by the extension, kept outside the workspace
 * folder. Standing command approvals live here rather than in workspace
 * settings: .vscode/settings.json ships with a repository, so a cloned project
 * could otherwise arrive carrying its own permission grants and silently
 * disable the approval prompt for commands it defines.
 */
export function getWorkspaceState(): vscodeTypes.Memento {
  if (!extensionContext) throw new Error("Extension context not initialized.");
  return extensionContext.workspaceState;
}
