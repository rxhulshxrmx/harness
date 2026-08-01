# Harness

An agentic coding assistant that runs entirely inside VS Code (and VS Code-based
editors like Cursor), powered by SAP AI Core. No separate server process — the
agent loop, tools, and streaming chat client all run in the extension host. The
only network calls it makes are to your own SAP AI Core endpoint.

## Install

You need one file: `harness-<version>.vsix`. Pick whichever is easier.

**From the editor (no terminal):**

1. Open the Extensions view (`Cmd/Ctrl+Shift+X`).
2. Click the `...` menu at the top of that panel → **Install from VSIX…**
3. Select the `.vsix` file.
4. Reload the window when prompted (`Cmd/Ctrl+Shift+P` → **Developer: Reload Window**).

**From a terminal:**

```sh
code --install-extension harness-0.0.9.vsix     # VS Code
cursor --install-extension harness-0.0.9.vsix   # Cursor
```

Then reload the window.

To upgrade later, install the new `.vsix` the same way — the version number must
be higher, otherwise the editor keeps the cached copy.

## Set up credentials

Everything is entered in the panel; you never have to edit `settings.json`.

1. Click the Harness icon in the activity bar (left edge).
2. Click the gear icon in the panel header.
3. Fill in the fields from your SAP AI Core service key:

   | Field | Where it comes from |
   |---|---|
   | Client ID | `clientid` in the service key |
   | Client secret | `clientsecret` in the service key |
   | AI Core base URL | `serviceurls.AI_API_URL` |
   | Auth URL | `url` |
   | Resource group | usually `default` |
   | Deployment ID | the deployment serving your model |

4. Close settings (✕) and send a message.

The client secret is stored in your OS keychain via the editor's SecretStorage,
not in `settings.json`. The other values are plain configuration and are written
to your workspace settings.

**Verify the connection first.** Before relying on it, run
`Cmd/Ctrl+Shift+P` → **Harness: Ping (debug)**. It sends one trivial message and
writes the result to the "Harness" output channel, so you can confirm auth and
streaming work against your deployment before starting real work.

## Using it

Type a request and press Enter. The agent reads files, searches, edits, and runs
commands to complete the task.

- **Approval mode** — the `Ask`/`Auto` pill in the composer. `Ask` (default)
  prompts before every shell command. `Auto` runs a small allowlist of read-only
  and test commands unattended and still prompts for everything else.
- **Rewind (⟲)** — hover any of your messages to undo that turn: the files it
  changed are restored and the chat is truncated back to that point.
- **History** — the clock icon lists past sessions in this workspace; each row
  has a delete button.
- **Touched files** — chips above the composer link to a diff, with a revert
  button per file.

### Keeping the agent away from certain files

Add a `.harnessignore` to the workspace root, same syntax as `.gitignore`. Listed
paths are excluded from `read_file`, `search_replace`, `grep`, and `list_dir`.
`.gitignore` is honoured too. Note this does not restrict shell commands the
agent runs.

### What gets written to your workspace

A `.harness/` directory holding session transcripts (`sessions/*.jsonl`) and
rewind checkpoints (`checkpoints/`). Checkpoints contain copies of file contents,
so add `.harness/` to your `.gitignore`.

## Configuration reference

Most people never need these — the settings panel covers the common ones.

| Setting | Default | Purpose |
|---|---|---|
| `harness.clientId` | `""` | SAP AI Core client ID |
| `harness.aiCoreBaseUrl` | `""` | `serviceurls.AI_API_URL` from the service key |
| `harness.tokenUrl` | `""` | OAuth token URL (`url` from the service key) |
| `harness.deploymentId` | `""` | Deployment to send inference requests to |
| `harness.resourceGroup` | `"default"` | AI Core resource group header |
| `harness.apiVersion` | `"2024-10-21"` | Inference API version |
| `harness.model` | `""` | Display-only label in the composer |
| `harness.approvalMode` | `"ask"` | `ask` or `auto` |
| `harness.contextBudget` | `100000` | Token budget before the transcript is compacted |

The client secret is deliberately absent from this table — it lives in
SecretStorage and has no `settings.json` key.

## Development

```sh
npm install
npm run build      # bundle the extension with esbuild
npm run watch      # rebuild on change
npm run typecheck
npm test           # node:test; most modules run without a vscode host
npm run package    # produces harness-<version>.vsix via vsce
```

Press `F5` to launch an Extension Development Host for anything that needs the
real `vscode` API — webview rendering, `WorkspaceEdit`, and live streaming
against a deployment.
