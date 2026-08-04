# Couplet

An agentic coding assistant that runs entirely inside VS Code (and VS Code-based
editors like Cursor), powered by SAP AI Core. No separate server process — the
agent loop, tools, and streaming chat client all run in the extension host. The
only network calls it makes are to your own SAP AI Core endpoint.

## Install

You need one file: `couplet-<version>.vsix`. Pick whichever is easier.

**From the editor (no terminal):**

1. Open the Extensions view (`Cmd/Ctrl+Shift+X`).
2. Click the `...` menu at the top of that panel → **Install from VSIX…**
3. Select the `.vsix` file.
4. Reload the window when prompted (`Cmd/Ctrl+Shift+P` → **Developer: Reload Window**).

**From a terminal:**

```sh
code --install-extension couplet-0.0.17.vsix     # VS Code
cursor --install-extension couplet-0.0.17.vsix   # Cursor
```

Then reload the window.

To upgrade later, install the new `.vsix` the same way — the version number must
be higher, otherwise the editor keeps the cached copy.

## Set up credentials

Everything is entered in the panel; you never have to edit `settings.json`.

1. Click the Couplet icon in the activity bar (left edge).
2. Click the gear icon in the panel header.
3. Fill in the fields from your SAP AI Core service key:

   | Field | Where it comes from |
   |---|---|
   | Client ID | `clientid` in the service key |
   | Client secret | `clientsecret` in the service key |
   | AI Core base URL | `serviceurls.AI_API_URL` |
   | Auth URL | `url` |
   | Resource group | usually `default` |

   There is no deployment ID to find: Couplet lists the running deployments in
   your resource group and resolves the right one from the model you pick.

4. Click **Test connection**. It lists your deployments and then sends one
   trivial message, so you know credentials, endpoint, and streaming all work
   before you start a real task rather than finding out midway through one.
5. Close settings (✕), pick a model from the composer, and send a message.

The client secret is stored in your OS keychain via the editor's SecretStorage,
not in `settings.json`. The other values are plain configuration, written to your
user settings so they follow you into every workspace.

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

Add a `.coupletignore` to the workspace root, same syntax as `.gitignore`. Listed
paths are excluded from `read_file`, `search_replace`, `grep`, and `list_dir`.
`.gitignore` is honoured too. Note this does not restrict shell commands the
agent runs.

### What gets written to your workspace

A `.couplet/` directory holding session transcripts (`sessions/*.jsonl`) and
rewind checkpoints (`checkpoints/`). Checkpoints contain copies of file contents,
so add `.couplet/` to your `.gitignore`.

## Configuration reference

Most people never need these — the settings panel covers the common ones.

| Setting | Default | Purpose |
|---|---|---|
| `couplet.clientId` | `""` | SAP AI Core client ID |
| `couplet.aiCoreBaseUrl` | `""` | `serviceurls.AI_API_URL` from the service key |
| `couplet.tokenUrl` | `""` | OAuth token URL (`url` from the service key) |
| `couplet.deploymentId` | `""` | Optional. Pins one deployment; empty means resolve it from the model |
| `couplet.resourceGroup` | `"default"` | AI Core resource group header |
| `couplet.apiVersion` | `"2024-10-21"` | Inference API version |
| `couplet.model` | `""` | Model to route to, as `name:version` |
| `couplet.approvalMode` | `"ask"` | `ask` or `auto` |
| `couplet.contextBudget` | `100000` | Token budget before the transcript is compacted |

The client secret is deliberately absent from this table — it lives in
SecretStorage and has no `settings.json` key.
