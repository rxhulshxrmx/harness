### Task 9: `agent/systemPrompt.ts` (base) + `agent/loop.ts` + M1 manual checkpoint

**Files:**
- Create: `src/agent/systemPrompt.ts`, `src/agent/loop.ts`
- Modify: `src/extension.ts` (add temporary `forge.runTurn` dev command)

**Interfaces:**
- Consumes: `Session` (Task 5), `estimateTokens` (Task 5), `chat` (Task 3), `getToolSchemas`, `runTool`, `truncate`, `getWorkspaceRoot` (Task 6).
- Produces: `systemMessage(session: Session): Message`; `UiPort { streamAssistantText(delta: string): void; requestApproval?(command: string): Promise<boolean> }`; `runTurn(session: Session, userText: string, ui: UiPort, signal: AbortSignal): Promise<void>` — consumed by `ui/panel.ts` in Task 12.

- [ ] **Step 1: Write `src/agent/systemPrompt.ts`** (base version — `{agentsMd}` is empty until Task 19)

```ts
import * as os from "node:os";
import type { Session } from "../state/session";
import type { Message } from "../aicore/types";
import { getWorkspaceRoot } from "../tools/index";
import { loadAgentsMd } from "./agentsMd";

export function systemMessage(session: Session): Message {
  const workspaceRoot = getWorkspaceRoot();
  const platform = os.platform();
  const shell = process.env.SHELL ?? (platform === "win32" ? "powershell.exe" : "/bin/bash");
  const date = new Date().toISOString().slice(0, 10);
  const agentsMd = loadAgentsMd(workspaceRoot);

  const content = `You are Forge, a coding agent running inside VS Code. You are precise, safe, and
helpful. You complete tasks autonomously using your tools and only yield back to
the user when the task is resolved or you are blocked on their input.

Environment:
- Workspace root: ${workspaceRoot}
- Platform: ${platform}
- Shell: ${shell}
- Today: ${date}

How to work:
- Before editing any file, read it first. Never edit content you have not seen this
  session.
- Explore with grep and list_dir instead of guessing paths. Prefer grep for finding
  where things are defined or used.
- Make minimal, focused edits with search_replace. Do not reformat code you are not
  changing. Match the existing style of the codebase.
- Fix problems at the root cause, not with surface patches. Do not fix unrelated
  bugs; mention them instead.
- After substantive changes, validate: run the narrowest relevant test or build
  command available. Do not add tests to codebases that have none.
- Do not git commit, create branches, or push unless explicitly asked.
- Do not add comments, copyright headers, or one-letter variable names.
- If AGENTS.md instructions below conflict with these rules, AGENTS.md wins for
  style; safety rules always win.

Communication:
- Before a group of related tool calls, send one short sentence saying what you are
  about to do. Do not narrate every trivial read.
- Final answers are concise: what changed, where, how it was validated, what is left.

${agentsMd}`;

  return { role: "system", content };
}
```

Note: `systemPrompt.ts` imports `./agentsMd`, built in full in Task 19. For this task, stub it:

```ts
// src/agent/agentsMd.ts (temporary stub — replaced in Task 19)
export function loadAgentsMd(_workspaceRoot: string): string {
  return "";
}
```

- [ ] **Step 2: Write `src/agent/loop.ts`**

```ts
import { chat } from "../aicore/client";
import { estimateTokens } from "./tokens";
import { systemMessage } from "./systemPrompt";
import { compact } from "./compaction";
import { getToolSchemas, runTool, getWorkspaceRoot } from "../tools/index";
import type { Session } from "../state/session";
import { appendToStore } from "../state/store";

const MAX_STEPS = 40;

export interface UiPort {
  streamAssistantText(delta: string): void;
  requestApproval(command: string): Promise<boolean>;
  showTurnDiff(files: string[]): void;
  showError(message: string): void;
}

export async function runTurn(session: Session, userText: string, ui: UiPort, signal: AbortSignal): Promise<void> {
  session.messages.push({ role: "user", content: userText });
  appendToStore(session, { role: "user", content: userText });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;

      const cfg = require("vscode").workspace.getConfiguration("forge");
      const budget = cfg.get<number>("contextBudget", 100_000);
      if (estimateTokens(session.messages) > budget * 0.75) {
        await compact(session);
      }

      const assistant = await chat(
        [systemMessage(session), ...session.messages],
        getToolSchemas(),
        (d) => ui.streamAssistantText(d),
        signal,
      );
      session.messages.push(assistant);
      appendToStore(session, assistant);

      if (!assistant.tool_calls?.length) return;

      for (const call of assistant.tool_calls) {
        if (signal.aborted) return;
        const result = await runTool(call.function.name, call.function.arguments, {
          workspaceRoot: getWorkspaceRoot(),
          signal,
        });
        const msg = { role: "tool" as const, tool_call_id: call.id, content: result };
        session.messages.push(msg);
        appendToStore(session, msg);
      }
    }
    ui.showError(`Step budget (${MAX_STEPS}) exhausted for this turn.`);
  } catch (err) {
    ui.showError(err instanceof Error ? err.message : String(err));
  }
}
```

Design notes for the implementer:
- `require("vscode")` inline (rather than a top-level `import`) is deliberate here only to keep this early version of `loop.ts` decoupled from a hard `vscode` import while `UiPort`'s approval/bash wiring doesn't exist yet. **Task 10 replaces this** with a proper top-level `import * as vscode from "vscode"` once `bash.ts` needs the same config — do not leave the inline `require` in the final version.
- `compact` is imported from `./compaction`, built in full in Task 18. Stub it for now:

```ts
// src/agent/compaction.ts (temporary stub — replaced in Task 18)
import type { Session } from "../state/session";
export async function compact(_session: Session): Promise<void> {}
```

- `appendToStore` is imported from `../state/store`, built in full in Task 16. Stub it for now:

```ts
// src/state/store.ts (temporary stub — replaced in Task 16)
import type { Session } from "./session";
import type { Message } from "../aicore/types";
export function appendToStore(_session: Session, _message: Message): void {}
```

- [ ] **Step 3: Add a temporary dev command to `src/extension.ts`**

```ts
// add inside activate(), alongside forge.ping
import { runTurn } from "./agent/loop";
import { createSession } from "./state/session";
import "./tools/readFile";
import "./tools/listDir";
import "./tools/grep";
import "./tools/searchReplace";

context.subscriptions.push(
  vscode.commands.registerCommand("forge.runTurn", async () => {
    const text = await vscode.window.showInputBox({ prompt: "Forge task" });
    if (!text) return;
    output.show(true);
    const session = createSession(text, "debug");
    const controller = new AbortController();
    await runTurn(
      session,
      text,
      {
        streamAssistantText: (d) => output.append(d),
        requestApproval: async (cmd) => {
          const choice = await vscode.window.showWarningMessage(`Run: ${cmd}`, "Approve", "Deny");
          return choice === "Approve";
        },
        showTurnDiff: (files) => output.appendLine(`\n[touched] ${files.join(", ")}`),
        showError: (msg) => output.appendLine(`\n[error] ${msg}`),
      },
      controller.signal,
    );
  }),
);
```

Also register the command in `package.json`'s `contributes.commands`: `{ "command": "forge.runTurn", "title": "Forge: Run Turn (debug)" }`.

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 5: Manual verification (M1 checkpoint)**

1. `F5` to launch the Extension Development Host on a real multi-file repo.
2. Run "Forge: Run Turn (debug)", enter: `find where X is defined and rename it to Y across the repo` (substitute a real symbol from the test repo).
3. Expected: the output channel shows the model using `grep`/`list_dir`/`read_file` tool calls (visible as raw tool_call JSON in this debug harness — that's fine, the real UI comes in M2), then `search_replace` edits landing in the actual files, then a final text answer.
4. Open one of the edited files — the change should be present and the file should already be saved (search_replace calls `doc.save()`).
5. Try asking something that requires a bash command (e.g. "run the tests") — expected: nothing happens yet, since `bash` isn't registered until Task 10; the model's tool call should come back as `Unknown tool: bash` and the model should say it can't run commands. This confirms `runTool`'s unknown-tool path works.
6. Do not proceed to Task 10 until step 3 works against a real deployment and real files.

- [ ] **Step 6: Commit**

```bash
git add src/agent/systemPrompt.ts src/agent/agentsMd.ts src/agent/loop.ts src/agent/compaction.ts src/state/store.ts src/extension.ts package.json
git commit -m "feat: agent turn loop with system prompt (M1 checkpoint)"
```

---

