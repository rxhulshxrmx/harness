# Harness

An agentic coding assistant that runs entirely inside VS Code (and VS Code-based
editors like Cursor), powered by SAP AI Core. No separate server process — the
agent loop, tools, and streaming chat client all run in the extension host.

## Setup

1. Open the Harness view from the activity bar.
2. Set the following in your workspace or user settings:
   - `harness.serviceKeyPath` — path to your SAP AI Core service key JSON file.
   - `harness.deploymentId` — the AI Core deployment to use.
   - `harness.resourceGroup` — defaults to `"default"`.
3. Start a new session and send a message.

## Features

- A chat panel with streaming responses and per-turn file-diff tracking.
- Tools: `read_file`, `list_dir`, `grep`, `search_replace`, `bash`.
- A rule-based command-approval policy (`harness.approvalMode`: `ask` or `auto`),
  plus per-file `.harnessignore` exclusion.
- Secret redaction on tool output before it's shown or persisted.
- Per-turn checkpoints with rewind (⟲): undo a turn's chat messages and file
  changes together.
- Session history persisted as JSONL under `.harness/sessions/`.

## Development

```sh
npm install
npm run build      # bundle the extension with esbuild
npm run watch       # rebuild on change
npm run typecheck
npm test            # node:test, no vscode dependency required for most modules
npm run package      # produces harness-<version>.vsix via vsce
```

Press `F5` in VS Code to launch an Extension Development Host for manual
verification of anything that touches the `vscode` API directly (webview
rendering, `WorkspaceEdit`, live streaming against a real deployment).
