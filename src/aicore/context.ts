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
