### Task 4: `extension.ts` activation + `forge.ping` (M0 checkpoint)

**Files:**
- Create: `src/extension.ts`

**Interfaces:**
- Consumes: `chat` from Task 3.

- [ ] **Step 1: Write `src/extension.ts`**

```ts
import * as vscode from "vscode";
import { chat } from "./aicore/client";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Forge");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.ping", async () => {
      output.show(true);
      output.appendLine("Sending: say hello");
      try {
        const reply = await chat(
          [{ role: "user", content: "say hello" }],
          [],
          (delta) => output.append(delta),
        );
        output.appendLine("");
        output.appendLine(`[done] finish content length: ${(reply.content ?? "").length}`);
      } catch (err) {
        output.appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export function deactivate() {}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `dist/extension.js` produced, no esbuild errors.

- [ ] **Step 3: Manual verification (M0 checkpoint)**

1. Set `forge.serviceKeyPath`, `forge.deploymentId`, `forge.resourceGroup` in workspace settings, pointing at a real SAP AI Core deployment's service key.
2. Press `F5` to launch the Extension Development Host.
3. Run command palette → "Forge: Ping (debug)".
4. Expected: the "Forge" output channel shows the streamed reply appearing incrementally (not all at once), followed by a `[done]` line.
5. Temporarily rename `forge.serviceKeyPath` to an invalid path, re-run — expected: `[error] forge.serviceKeyPath is not set.` (or ENOENT) surfaces in the channel without crashing the extension host.
6. Do not proceed to Task 5 until streaming and the error path both work against a real deployment.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: activation with forge.ping debug command (M0 checkpoint)"
```

---

