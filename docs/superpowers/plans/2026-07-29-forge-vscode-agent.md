# Forge VS Code Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build "Forge", a VS Code extension providing an agentic coding assistant powered entirely by SAP AI Core, running inside the extension host with no separate server process.

**Architecture:** A plain-function agent core (auth → streaming chat client → tool-calling loop) drives five tools (read_file, list_dir, grep, search_replace, bash) with a VS Code webview sidebar as the only UI. Diffs are tracked per-turn via file snapshots and rendered through `vscode.diff`. Sessions persist as JSONL under `.forge/sessions/`.

**Tech Stack:** TypeScript, Node 20+ stdlib, VS Code Extension API, esbuild (bundler), `ignore` (npm, gitignore parsing — the only production dependency). Tests use Node's built-in `node:test` + `node:assert` runner (no third-party test framework), run with `node --experimental-strip-types --test` (verified working on this machine: Node v24.6.0).

## Global Constraints

(Copied verbatim from the spec — every task's requirements implicitly include these.)

- Language: TypeScript. Node 20+. No Python.
- Runs entirely inside the VS Code extension host. No separate server process.
- The ONLY external network calls are to SAP AI Core (token endpoint + inference endpoint).
- No third-party agent frameworks (no LangChain, LangGraph, Vercel AI SDK). Only allowed npm production dependency: `ignore`.
- Plain, readable functions. No classes deeper than one level of inheritance. No decorators.
- Credentials come from a JSON service key file at `forge.serviceKeyPath`. Never hardcode credentials. Never log tokens.
- All workspace paths resolved relative to the first workspace folder; any resolved path that escapes the root (`path.relative` starts with `..`) is rejected.
- Tool results truncated to 20,000 chars, middle-elided (head 8k + `"\n…[truncated]…\n"` + tail 8k) before entering the transcript.
- MAX_STEPS per turn = 40.
- Escape all HTML from model output before rendering in the webview (`textContent`, never `innerHTML` with raw model text). Strict webview CSP.

## File Structure

```
forge/
  package.json  tsconfig.json  esbuild.mjs
  src/
    extension.ts
    aicore/  auth.ts  client.ts  sse.ts  types.ts
    agent/   loop.ts  systemPrompt.ts  compaction.ts  tokens.ts
    tools/   index.ts  readFile.ts  listDir.ts  grep.ts  searchReplace.ts  bash.ts
    state/   session.ts  store.ts  diffTracker.ts
    ui/      panel.ts  webview/index.html  webview/main.js  webview/style.css
```

Deviation from the spec's literal file list: `aicore/sse.ts` is added. It holds the pure (no `vscode` import) SSE-buffer-splitting and tool-call-delta-merging logic that `client.ts` uses, so it can be unit tested with `node:test` without a VS Code host. This is an internal implementation split of `client.ts`, not a new externally-visible module — the spec's "isolate backend differences in client.ts" rule is unaffected since `sse.ts` has no knowledge of SAP AI Core specifics.

Files needing a live `vscode` API (webview rendering, `WorkspaceEdit`, `workspace.workspaceFolders`, streaming from a real deployment) are verified manually via the Extension Development Host (`F5`), matching the spec's own §11/§12 manual-verification approach — they are not unit-testable in isolation without the heavy `@vscode/test-electron` harness, which the spec does not call for.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `.gitignore`, `.vscode/launch.json`

**Interfaces:**
- Produces: npm scripts `build`, `watch`, `test`, `package`; the `forge.*` configuration keys later tasks read via `vscode.workspace.getConfiguration("forge")`.

- [ ] **Step 1: Init git and npm**

```bash
cd /Users/rahulsharma/Developer/Forge
git init
npm init -y
npm install --save ignore
npm install --save-dev typescript @types/node @types/vscode esbuild @vscode/vsce
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist-check",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `esbuild.mjs`**

```js
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
});

if (watch) {
  await ctx.watch();
  console.log("watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
```

- [ ] **Step 4: Write `package.json` scripts and `contributes` block**

```jsonc
{
  "name": "forge",
  "displayName": "Forge",
  "publisher": "internal",
  "version": "0.0.1",
  "private": true,
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "activationEvents": [],
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test src/**/*.test.ts",
    "package": "vsce package"
  },
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "forge", "title": "Forge", "icon": "media/icon.svg" }]
    },
    "views": {
      "forge": [{ "type": "webview", "id": "forge.chat", "name": "Chat" }]
    },
    "commands": [
      { "command": "forge.newSession", "title": "Forge: New Session" },
      { "command": "forge.ping", "title": "Forge: Ping (debug)" }
    ],
    "configuration": {
      "properties": {
        "forge.serviceKeyPath": { "type": "string", "default": "" },
        "forge.deploymentId": { "type": "string", "default": "" },
        "forge.resourceGroup": { "type": "string", "default": "default" },
        "forge.apiVersion": { "type": "string", "default": "2024-10-21" },
        "forge.model": { "type": "string", "default": "" },
        "forge.approvalMode": { "type": "string", "enum": ["ask", "auto"], "default": "ask" },
        "forge.contextBudget": { "type": "number", "default": 100000 }
      }
    }
  },
  "dependencies": { "ignore": "^5.3.0" }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
dist-check/
*.vsix
```

- [ ] **Step 6: Write `media/icon.svg`** (any simple placeholder square SVG is fine — VS Code just needs a valid file at that path)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="currentColor"/></svg>
```

- [ ] **Step 7: Verify scaffolding compiles**

Run: `npx tsc --noEmit`
Expected: no errors (no `.ts` files yet, so this is a no-op success — just confirms `tsconfig.json` is valid).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json esbuild.mjs .gitignore media/icon.svg package-lock.json
git commit -m "chore: scaffold Forge extension project"
```

---

### Task 2: `aicore/types.ts` + `aicore/auth.ts`

**Files:**
- Create: `src/aicore/types.ts`, `src/aicore/auth.ts`, `src/aicore/auth.test.ts`

**Interfaces:**
- Produces: `ServiceKey`, `Message`, `AssistantMessage`, `ToolCall`, `ToolSchema` types; `getToken(key): Promise<string>`, `invalidateToken(): void`.

- [ ] **Step 1: Write `src/aicore/types.ts`**

```ts
export interface ServiceKey {
  clientid: string;
  clientsecret: string;
  url: string;
  serviceurls: { AI_API_URL: string };
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AssistantMessage extends Message {
  role: "assistant";
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}
```

- [ ] **Step 2: Write the failing test for auth.ts**

```ts
// src/aicore/auth.test.ts
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getToken, invalidateToken } from "./auth";
import type { ServiceKey } from "./types";

const key: ServiceKey = {
  clientid: "id",
  clientsecret: "secret",
  url: "https://auth.example.com",
  serviceurls: { AI_API_URL: "https://api.example.com" },
};

beforeEach(() => {
  invalidateToken();
});

test("getToken fetches and caches a token", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({ access_token: "tok-1", expires_in: 3600 }),
    } as Response;
  });

  const t1 = await getToken(key);
  const t2 = await getToken(key);

  assert.equal(t1, "tok-1");
  assert.equal(t2, "tok-1");
  assert.equal(calls, 1, "second call should hit the cache, not fetch again");
  mock.reset();
});

test("getToken throws on non-ok response", async () => {
  mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401 }) as Response);
  await assert.rejects(() => getToken(key), /Token fetch failed: 401/);
  mock.reset();
});

test("invalidateToken forces a refetch", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) } as Response;
  });

  await getToken(key);
  invalidateToken();
  const t2 = await getToken(key);

  assert.equal(calls, 2);
  assert.equal(t2, "tok-2");
  mock.reset();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsc --noEmit` (should fail — `./auth` module doesn't exist yet)
Expected: `Cannot find module './auth'`

- [ ] **Step 4: Write `src/aicore/auth.ts`**

```ts
import type { ServiceKey } from "./types";

let cached: { token: string; expiresAt: number } | null = null;

export async function getToken(key: ServiceKey): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch(`${key.url}/oauth/token?grant_type=client_credentials`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${key.clientid}:${key.clientsecret}`).toString("base64"),
    },
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const body = await res.json();
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

export function invalidateToken(): void {
  cached = null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/aicore/auth.test.ts`
Expected: `# pass 3`

- [ ] **Step 6: Commit**

```bash
git add src/aicore/types.ts src/aicore/auth.ts src/aicore/auth.test.ts
git commit -m "feat: SAP AI Core OAuth2 token manager"
```

---

### Task 3: `aicore/sse.ts` + `aicore/client.ts`

**Files:**
- Create: `src/aicore/sse.ts`, `src/aicore/sse.test.ts`, `src/aicore/client.ts`

**Interfaces:**
- Consumes: `getToken`, `invalidateToken` from Task 2; `Message`, `AssistantMessage`, `ToolSchema`, `ToolCall`, `ServiceKey` from Task 2.
- Produces: `chat(messages: Message[], tools: ToolSchema[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<AssistantMessage>` — used by `agent/loop.ts` in Task 13.

- [ ] **Step 1: Write the failing test for sse.ts**

```ts
// src/aicore/sse.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSSEBuffer, mergeToolCallDelta } from "./sse";

test("splitSSEBuffer splits complete events and keeps the remainder", () => {
  const buf = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: partial';
  const { events, rest } = splitSSEBuffer(buf);
  assert.deepEqual(events, ['data: {"a":1}', 'data: {"b":2}']);
  assert.equal(rest, "data: partial");
});

test("mergeToolCallDelta accumulates fragments by index", () => {
  let acc: any[] = [];
  acc = mergeToolCallDelta(acc, [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"file' } }]);
  acc = mergeToolCallDelta(acc, [{ index: 0, function: { arguments: '_path":"a.ts"}' } }]);
  assert.equal(acc[0].id, "call_1");
  assert.equal(acc[0].function.name, "read_file");
  assert.equal(acc[0].function.arguments, '{"file_path":"a.ts"}');
});

test("mergeToolCallDelta handles two concurrent tool calls", () => {
  let acc: any[] = [];
  acc = mergeToolCallDelta(acc, [
    { index: 0, id: "call_1", function: { name: "read_file", arguments: "{}" } },
    { index: 1, id: "call_2", function: { name: "grep", arguments: "{}" } },
  ]);
  assert.equal(acc.length, 2);
  assert.equal(acc[1].function.name, "grep");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './sse'`

- [ ] **Step 3: Write `src/aicore/sse.ts`**

```ts
import type { ToolCall } from "./types";

export function splitSSEBuffer(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts.filter((p) => p.length > 0), rest };
}

export function mergeToolCallDelta(acc: ToolCall[], deltaCalls: any[]): ToolCall[] {
  for (const d of deltaCalls) {
    const idx = d.index;
    if (!acc[idx]) {
      acc[idx] = { id: d.id ?? "", type: "function", function: { name: "", arguments: "" } };
    }
    if (d.id) acc[idx].id = d.id;
    if (d.function?.name) acc[idx].function.name += d.function.name;
    if (d.function?.arguments) acc[idx].function.arguments += d.function.arguments;
  }
  return acc;
}

export function extractDataLines(event: string): string[] {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/aicore/sse.test.ts`
Expected: `# pass 3`

- [ ] **Step 5: Write `src/aicore/client.ts`**

```ts
import * as vscode from "vscode";
import * as fs from "node:fs";
import { getToken, invalidateToken } from "./auth";
import { splitSSEBuffer, mergeToolCallDelta, extractDataLines } from "./sse";
import type { Message, AssistantMessage, ToolSchema, ToolCall, ServiceKey } from "./types";

function loadServiceKey(keyPath: string): ServiceKey {
  if (!keyPath) throw new Error("forge.serviceKeyPath is not set.");
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration("forge");
  return {
    serviceKeyPath: cfg.get<string>("serviceKeyPath", ""),
    deploymentId: cfg.get<string>("deploymentId", ""),
    resourceGroup: cfg.get<string>("resourceGroup", "default"),
    apiVersion: cfg.get<string>("apiVersion", "2024-10-21"),
  };
}

export async function chat(
  messages: Message[],
  tools: ToolSchema[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const { serviceKeyPath, deploymentId, resourceGroup, apiVersion } = readConfig();
  const key = loadServiceKey(serviceKeyPath);
  const url = `${key.serviceurls.AI_API_URL}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=${apiVersion}`;

  let attempt = 0;
  let retriedAfter401 = false;

  for (;;) {
    if (signal?.aborted) throw new Error("Aborted");
    const token = await getToken(key);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "AI-Resource-Group": resourceGroup,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages, tools, tool_choice: "auto", stream: true }),
      signal,
    });

    if (res.status === 401 && !retriedAfter401) {
      retriedAfter401 = true;
      invalidateToken();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      attempt++;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`AI Core request failed: ${res.status} ${await res.text()}`);
    }

    return readStream(res, onDelta);
  }
}

async function readStream(res: Response, onDelta: (text: string) => void): Promise<AssistantMessage> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let toolCalls: ToolCall[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitSSEBuffer(buffer);
    buffer = rest;
    for (const event of events) {
      for (const data of extractDataLines(event)) {
        if (data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (delta.tool_calls) {
          toolCalls = mergeToolCallDelta(toolCalls, delta.tool_calls);
        }
      }
    }
  }

  return { role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined };
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/aicore/sse.ts src/aicore/sse.test.ts src/aicore/client.ts
git commit -m "feat: SAP AI Core streaming chat client with retry/backoff"
```

---

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

### Task 5: `agent/tokens.ts` + `state/session.ts`

**Files:**
- Create: `src/agent/tokens.ts`, `src/agent/tokens.test.ts`, `src/state/session.ts`

**Interfaces:**
- Produces: `estimateTokens(messages: Message[]): number`; `Session` type with `id`, `title`, `createdAt`, `messages: Message[]`; `createSession(firstUserText: string): Session`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/tokens.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "./tokens";

test("estimateTokens is roughly chars/4 across all messages", () => {
  const messages = [
    { role: "user" as const, content: "a".repeat(400) },
    { role: "assistant" as const, content: "b".repeat(400), tool_calls: undefined },
  ];
  assert.equal(estimateTokens(messages), 200);
});

test("estimateTokens counts tool_calls argument text", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [{ id: "1", type: "function" as const, function: { name: "grep", arguments: "x".repeat(40) } }],
    },
  ];
  assert.equal(estimateTokens(messages), 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './tokens'`

- [ ] **Step 3: Write `src/agent/tokens.ts`**

```ts
import type { Message } from "../aicore/types";

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const call of m.tool_calls ?? []) {
      chars += call.function.name.length + call.function.arguments.length;
    }
  }
  return Math.ceil(chars / 4);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/agent/tokens.test.ts`
Expected: `# pass 2`

- [ ] **Step 5: Write `src/state/session.ts`**

```ts
import * as crypto from "node:crypto";
import type { Message } from "../aicore/types";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  model: string;
  messages: Message[];
  filePath?: string;
}

export function createSession(firstUserText: string, model: string): Session {
  const id = crypto.randomBytes(3).toString("hex");
  return {
    id,
    title: firstUserText.slice(0, 60),
    createdAt: new Date().toISOString(),
    model,
    messages: [],
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tokens.ts src/agent/tokens.test.ts src/state/session.ts
git commit -m "feat: token estimation and session model"
```

---

### Task 6: `tools/index.ts` registry + `tools/readFile.ts` + `tools/listDir.ts`

**Files:**
- Create: `src/tools/index.ts`, `src/tools/index.test.ts`, `src/tools/readFile.ts`, `src/tools/readFile.test.ts`, `src/tools/listDir.ts`

**Interfaces:**
- Produces: `resolveWithinRoot(root: string, filePath: string): string` (pure, throws on escape); `getWorkspaceRoot(): string` (vscode-dependent); `ToolDefinition { schema: ToolSchema; execute(argsJson: string, ctx: ToolContext): Promise<string> }`; `ToolContext { workspaceRoot: string; signal: AbortSignal }`; `registerTool`, `getToolSchemas(): ToolSchema[]`, `runTool(name, argsJson, ctx): Promise<string>`; `truncate(text: string): string`.
- Consumes (from later tasks registering themselves): none yet — `readFile` and `listDir` self-register via `registerTool` at module load.

- [ ] **Step 1: Write the failing test for `resolveWithinRoot` and `truncate`**

```ts
// src/tools/index.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWithinRoot, truncate } from "./index";

test("resolveWithinRoot allows paths inside the root", () => {
  const resolved = resolveWithinRoot("/ws", "src/a.ts");
  assert.equal(resolved, "/ws/src/a.ts");
});

test("resolveWithinRoot rejects paths that escape the root", () => {
  assert.throws(() => resolveWithinRoot("/ws", "../outside.ts"), /escapes workspace root/);
  assert.throws(() => resolveWithinRoot("/ws", "/etc/passwd"), /escapes workspace root/);
});

test("truncate leaves short text untouched", () => {
  assert.equal(truncate("hello"), "hello");
});

test("truncate middle-elides text over 20000 chars", () => {
  const text = "H".repeat(9000) + "M".repeat(10000) + "T".repeat(9000);
  const out = truncate(text);
  assert.equal(out.length, 8000 + "\n…[truncated]…\n".length + 8000);
  assert.ok(out.startsWith("H".repeat(8000)));
  assert.ok(out.endsWith("T".repeat(8000)));
  assert.ok(out.includes("…[truncated]…"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './index'`

- [ ] **Step 3: Write `src/tools/index.ts`**

```ts
import * as path from "node:path";
import * as vscode from "vscode";
import type { ToolSchema } from "../aicore/types";

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute: (argsJson: string, ctx: ToolContext) => Promise<string>;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(name: string, def: ToolDefinition): void {
  registry.set(name, def);
}

export function getToolSchemas(): ToolSchema[] {
  return [...registry.values()].map((d) => d.schema);
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<string> {
  const def = registry.get(name);
  if (!def) return `Unknown tool: ${name}`;
  try {
    const result = await def.execute(argsJson, ctx);
    return truncate(result);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function resolveWithinRoot(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }
  return resolved;
}

export function getWorkspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error("No workspace folder open.");
  return root;
}

const MAX_LEN = 20_000;
const HALF = 8_000;

export function truncate(text: string): string {
  if (text.length <= MAX_LEN) return text;
  return text.slice(0, HALF) + "\n…[truncated]…\n" + text.slice(text.length - HALF);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/index.test.ts`
Expected: `# pass 4`

- [ ] **Step 5: Write the failing test for `readFile`**

```ts
// src/tools/readFile.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatFileContent } from "./readFile";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatFileContent numbers lines and reports the window", () => {
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "one\ntwo\nthree\n");
  const out = formatFileContent(file, 1, 400);
  assert.match(out, /^\s+1\tone$/m);
  assert.match(out, /^\s+3\tthree$/m);
});

test("formatFileContent respects offset/limit and reports truncation", () => {
  const file = path.join(dir, "b.txt");
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
  const out = formatFileContent(file, 2, 3);
  assert.match(out, /^\s+2\tline2$/m);
  assert.match(out, /^\s+4\tline4$/m);
  assert.doesNotMatch(out, /line5/);
  assert.match(out, /\[showing lines 2-4 of 10\]/);
});

test("formatFileContent reports binary files without reading them as text", () => {
  const file = path.join(dir, "bin.dat");
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 0, 255, 254]));
  const out = formatFileContent(file, 1, 400);
  assert.match(out, /^\[binary file, \d+ bytes\]$/);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './readFile'`

- [ ] **Step 7: Write `src/tools/readFile.ts`**

```ts
import * as fs from "node:fs";
import { registerTool, resolveWithinRoot, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

export function formatFileContent(absPath: string, offset: number, limit: number): string {
  const buf = fs.readFileSync(absPath);
  if (isBinary(buf)) return `[binary file, ${buf.length} bytes]`;

  const allLines = buf.toString("utf8").split("\n");
  const total = allLines.length;
  const start = Math.max(1, offset);
  const end = Math.min(total, start + limit - 1);
  const window = allLines.slice(start - 1, end);

  const width = String(end).length;
  const body = window.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join("\n");

  if (start === 1 && end === total) return body;
  return `${body}\n[showing lines ${start}-${end} of ${total}]`;
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns content with line numbers. Use offset/limit for large files.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "integer", description: "1-based first line, default 1" },
        limit: { type: "integer", description: "max lines, default 400" },
      },
      required: ["file_path"],
    },
  },
};

registerTool("read_file", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.file_path);
    return formatFileContent(abs, args.offset ?? 1, args.limit ?? 400);
  },
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/readFile.test.ts`
Expected: `# pass 3`

- [ ] **Step 9: Write `src/tools/listDir.ts`** (manual verification only — depends on `vscode.workspace` for the root and reads the real filesystem tree; covered by the M1 manual check in Task 9)

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { registerTool, resolveWithinRoot, getWorkspaceRoot, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

const HARD_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".forge"]);
const MAX_ENTRIES = 500;

function loadIgnorer(root: string) {
  const ig = ignore();
  const gitignorePath = path.join(root, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  return ig;
}

export function buildTree(root: string, startAbs: string, depth: number, ig: ReturnType<typeof ignore>): string {
  const lines: string[] = [];
  let count = 0;

  function walk(dirAbs: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth || count >= MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (count >= MAX_ENTRIES) return;
      if (HARD_EXCLUDES.has(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(root, abs);
      if (ig.ignores(rel)) continue;
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      count++;
      if (entry.isDirectory()) walk(abs, currentDepth + 1, prefix + "  ");
    }
  }

  walk(startAbs, 1, "");
  return lines.length ? lines.join("\n") : "(empty)";
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "list_dir",
    description: "List files and directories as an indented tree, respecting .gitignore.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "default '.'" },
        depth: { type: "integer", description: "default 2, max 4" },
      },
    },
  },
};

registerTool("list_dir", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson || "{}");
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.path ?? ".");
    const depth = Math.min(4, args.depth ?? 2);
    const ig = loadIgnorer(ctx.workspaceRoot);
    return buildTree(ctx.workspaceRoot, abs, depth, ig);
  },
});

export { getWorkspaceRoot };
```

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/tools/index.ts src/tools/index.test.ts src/tools/readFile.ts src/tools/readFile.test.ts src/tools/listDir.ts
git commit -m "feat: tool registry, path guard, read_file, list_dir"
```

---

### Task 7: `tools/grep.ts`

**Files:**
- Create: `src/tools/grep.ts`, `src/tools/grep.test.ts`

**Interfaces:**
- Consumes: `resolveWithinRoot`, `registerTool` from Task 6.
- Produces: pure `searchInText(content: string, pattern: RegExp, filePath: string, maxResults: number): string[]` used by the tool's `execute` when walking the filesystem.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/grep.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchInText } from "./grep";

test("searchInText returns path:line:text for each match", () => {
  const content = "foo\nbar getToken\nbaz\ngetToken again";
  const hits = searchInText(content, /getToken/, "src/a.ts", 100);
  assert.deepEqual(hits, ["src/a.ts:2: bar getToken", "src/a.ts:4: getToken again"]);
});

test("searchInText stops at maxResults", () => {
  const content = "x\nx\nx\nx";
  const hits = searchInText(content, /x/, "f.ts", 2);
  assert.equal(hits.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './grep'`

- [ ] **Step 3: Write `src/tools/grep.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { registerTool, resolveWithinRoot, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

const HARD_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".forge"]);
const MAX_FILE_BYTES = 1_000_000;

export function searchInText(content: string, pattern: RegExp, filePath: string, maxResults: number): string[] {
  const hits: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
    if (pattern.test(lines[i])) {
      hits.push(`${filePath}:${i + 1}: ${lines[i]}`);
    }
    pattern.lastIndex = 0;
  }
  return hits;
}

function matchesGlob(rel: string, glob?: string): boolean {
  if (!glob) return true;
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, " ")
        .replace(/\*/g, "[^/]*")
        .replace(/ /g, ".*") +
      "$",
  );
  return re.test(rel);
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents by regex across the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string", description: "e.g. '**/*.ts'" },
        max_results: { type: "integer", description: "default 100" },
      },
      required: ["pattern"],
    },
  },
};

registerTool("grep", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const maxResults = args.max_results ?? 100;
    const re = new RegExp(args.pattern);
    const ig = ignore();
    const gitignorePath = path.join(ctx.workspaceRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) ig.add(fs.readFileSync(gitignorePath, "utf8"));

    const results: string[] = [];

    function walk(dirAbs: string) {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (HARD_EXCLUDES.has(entry.name)) continue;
        const abs = path.join(dirAbs, entry.name);
        const rel = path.relative(ctx.workspaceRoot, abs);
        if (ig.ignores(rel)) continue;
        if (entry.isDirectory()) {
          walk(abs);
        } else if (matchesGlob(rel, args.glob)) {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = fs.readFileSync(abs, "utf8").toString();
          results.push(...searchInText(content, re, rel, maxResults - results.length));
        }
      }
    }

    walk(resolveWithinRoot(ctx.workspaceRoot, "."));
    return results.length ? results.join("\n") : "No matches.";
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/grep.test.ts`
Expected: `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add src/tools/grep.ts src/tools/grep.test.ts
git commit -m "feat: grep tool with gitignore-aware workspace walk"
```

---

### Task 8: `tools/searchReplace.ts`

**Files:**
- Create: `src/tools/searchReplace.ts`, `src/tools/searchReplace.test.ts`

**Interfaces:**
- Consumes: `resolveWithinRoot`, `registerTool`, `truncate` from Task 6.
- Produces: pure `planReplacement(content: string | null, oldString: string, newString: string, replaceAll: boolean): { kind: "create" | "replace" | "error"; content?: string; error?: string; matchStartLine?: number }` — the string-matching logic, unit tested without touching the filesystem or `vscode`. The tool's `execute` wraps this with file I/O and `vscode.WorkspaceEdit` (manually verified).

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/searchReplace.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planReplacement } from "./searchReplace";

test("empty old_string on non-existent file creates it", () => {
  const plan = planReplacement(null, "", "hello", false);
  assert.equal(plan.kind, "create");
  assert.equal(plan.content, "hello");
});

test("zero matches is an error", () => {
  const plan = planReplacement("const a = 1;", "const b", "const c", false);
  assert.equal(plan.kind, "error");
  assert.match(plan.error!, /No match for old_string/);
});

test("multiple matches without replace_all is an error", () => {
  const plan = planReplacement("x\nx\nx", "x", "y", false);
  assert.equal(plan.kind, "error");
  assert.match(plan.error!, /matched 3 times/);
});

test("exactly one match replaces", () => {
  const plan = planReplacement("const a = 1;\nconst b = 2;", "const a = 1;", "const a = 2;", false);
  assert.equal(plan.kind, "replace");
  assert.equal(plan.content, "const a = 2;\nconst b = 2;");
});

test("replace_all replaces every occurrence", () => {
  const plan = planReplacement("x\nx\nx", "x", "y", true);
  assert.equal(plan.kind, "replace");
  assert.equal(plan.content, "y\ny\ny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './searchReplace'`

- [ ] **Step 3: Write `src/tools/searchReplace.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerTool, resolveWithinRoot, type ToolContext } from "./index";
import { diffTracker } from "../state/diffTracker";
import type { ToolSchema } from "../aicore/types";

export interface ReplacementPlan {
  kind: "create" | "replace" | "error";
  content?: string;
  error?: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

export function planReplacement(
  currentContent: string | null,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplacementPlan {
  if (oldString === "" && currentContent === null) {
    return { kind: "create", content: newString };
  }
  if (currentContent === null) {
    return { kind: "error", error: "File does not exist and old_string is not empty." };
  }

  const occurrences = countOccurrences(currentContent, oldString);
  if (occurrences === 0) {
    return { kind: "error", error: "No match for old_string in file. Read the file again — it may have changed." };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      kind: "error",
      error: `old_string matched ${occurrences} times. Add surrounding lines to make it unique, or set replace_all.`,
    };
  }

  const content = replaceAll
    ? currentContent.split(oldString).join(newString)
    : currentContent.replace(oldString, newString);
  return { kind: "replace", content };
}

function contextSnippet(content: string, newString: string): string {
  const lines = content.split("\n");
  const newLines = newString.split("\n");
  const idx = content.indexOf(newString);
  const before = content.slice(0, idx).split("\n").length - 1;
  const start = Math.max(0, before - 3);
  const end = Math.min(lines.length, before + newLines.length + 3);
  const width = String(end).length;
  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)
    .join("\n");
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "search_replace",
    description:
      "Edit a file by exact string replacement. old_string must match the file exactly once (including whitespace). Use an empty old_string to create a new file. Set replace_all to replace every occurrence.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
};

registerTool("search_replace", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.file_path);
    const exists = fs.existsSync(abs);
    const current = exists ? fs.readFileSync(abs, "utf8") : null;

    const plan = planReplacement(current, args.old_string, args.new_string, !!args.replace_all);
    if (plan.kind === "error") return `Error: ${plan.error} (${args.file_path})`;

    diffTracker.snapshot(args.file_path, current);

    if (plan.kind === "create") {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
    }

    const uri = vscode.Uri.file(abs);
    const edit = new vscode.WorkspaceEdit();
    if (plan.kind === "create") {
      edit.createFile(uri, { overwrite: true, contents: Buffer.from(plan.content!, "utf8") });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, fullRange, plan.content!);
    }
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();

    if (plan.kind === "create") return `Created ${args.file_path}`;
    return `Updated ${args.file_path}:\n${contextSnippet(plan.content!, args.new_string)}`;
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/searchReplace.test.ts`
Expected: `# pass 5`

Note: `searchReplace.ts` imports `../state/diffTracker`, which does not exist until Task 14. For this task, create a temporary stub so `tsc` passes, to be replaced wholesale in Task 14:

```ts
// src/state/diffTracker.ts (temporary stub — replaced in Task 14)
export const diffTracker = {
  snapshot(_filePath: string, _contentBefore: string | null) {},
};
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/searchReplace.ts src/tools/searchReplace.test.ts src/state/diffTracker.ts
git commit -m "feat: search_replace tool with exact-match semantics (diffTracker stub)"
```

---

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

### Task 10: `tools/bash.ts`

**Files:**
- Create: `src/tools/bash.ts`, `src/tools/bash.test.ts`
- Modify: `src/agent/loop.ts` (replace inline `require("vscode")` with a top-level import), `src/extension.ts` (register bash, wire real approval)

**Interfaces:**
- Consumes: `registerTool`, `resolveWithinRoot` (Task 6); `UiPort.requestApproval` (Task 9).
- Produces: pure `isAutoApproved(command: string): boolean` and `isNeverAutoApproved(command: string): boolean`, unit tested; `ToolContext` gains an optional `requestApproval` hook (bash needs to call back into the UI, so `ToolContext` in `tools/index.ts` is extended).

- [ ] **Step 1: Extend `ToolContext` in `src/tools/index.ts`**

```ts
// in src/tools/index.ts, change the ToolContext interface to:
export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  requestApproval: (command: string) => Promise<boolean>;
}
```

Update `runTurn` in `src/agent/loop.ts` to pass `requestApproval: ui.requestApproval` into the `ToolContext` object it builds.

- [ ] **Step 2: Write the failing test for the allowlist**

```ts
// src/tools/bash.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAutoApproved, isNeverAutoApproved } from "./bash";

test("read-only commands are auto-approved", () => {
  for (const cmd of ["git status", "git diff", "git log", "ls -la", "node --version", "npm ls"]) {
    assert.equal(isAutoApproved(cmd), true, cmd);
  }
});

test("prefix commands (npm test, npx tsc, pytest) are auto-approved", () => {
  assert.equal(isAutoApproved("npm test -- --watch"), true);
  assert.equal(isAutoApproved("npx tsc --noEmit"), true);
  assert.equal(isAutoApproved("pytest -k foo"), true);
});

test("unlisted commands are not auto-approved", () => {
  assert.equal(isAutoApproved("npm run build"), false);
});

test("never-auto-approve list always wins even in auto mode", () => {
  for (const cmd of ["rm -rf dist", "git push origin main", "git reset --hard", "curl http://x", "sudo ls"]) {
    assert.equal(isNeverAutoApproved(cmd), true, cmd);
  }
});

test("commands with redirection or absolute paths outside workspace are never auto-approved", () => {
  assert.equal(isNeverAutoApproved("echo hi > /etc/hosts"), true);
  assert.equal(isNeverAutoApproved("cat /etc/passwd"), true);
});

test("plain read commands are not in the never-auto-approve list", () => {
  assert.equal(isNeverAutoApproved("git status"), false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './bash'`

- [ ] **Step 4: Write `src/tools/bash.ts`**

```ts
import { spawn } from "node:child_process";
import * as os from "node:os";
import { registerTool, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

const READ_ONLY_EXACT = new Set([
  "git status",
  "git diff",
  "git log",
  "node --version",
  "npm ls",
  "python --version",
]);
const READ_ONLY_PREFIXES = ["ls", "dir", "cat", "type", "grep", "rg", "find", "npm test", "npx tsc", "pytest"];
const AUTO_APPROVE_PREFIXES = ["npm test", "npx tsc", "pytest"];

export function isAutoApproved(command: string): boolean {
  const trimmed = command.trim();
  if (READ_ONLY_EXACT.has(trimmed)) return true;
  const firstWord = trimmed.split(/\s+/)[0];
  if (["ls", "dir", "cat", "type", "grep", "rg", "find"].includes(firstWord)) return true;
  return AUTO_APPROVE_PREFIXES.some((p) => trimmed.startsWith(p));
}

const NEVER_AUTO_WORDS = ["rm ", "del ", "git push", "git reset", "curl ", "wget ", "sudo "];

export function isNeverAutoApproved(command: string): boolean {
  const trimmed = command.trim();
  if (NEVER_AUTO_WORDS.some((w) => trimmed.startsWith(w) || trimmed.includes(` ${w}`))) return true;
  if (/[>]/.test(trimmed)) return true;
  if (/\bsudo\b/.test(trimmed)) return true;
  if (/(^|\s)\/(?!$)/.test(trimmed) && !trimmed.startsWith("git ")) return true;
  return false;
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command in the workspace root.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", description: "default 60000, max 300000" },
      },
      required: ["command"],
    },
  },
};

registerTool("bash", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const command: string = args.command;
    const timeoutMs = Math.min(300_000, args.timeout_ms ?? 60_000);

    const vscode = require("vscode");
    const approvalMode = vscode.workspace.getConfiguration("forge").get<string>("approvalMode", "ask");

    const autoOk = approvalMode === "auto" && isAutoApproved(command) && !isNeverAutoApproved(command);
    if (!autoOk) {
      const approved = await ctx.requestApproval(command);
      if (!approved) return "User denied this command.";
    }

    return new Promise<string>((resolve) => {
      const isWin = os.platform() === "win32";
      const child = spawn(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd: ctx.workspaceRoot,
      });

      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(output + `\n[killed: exceeded ${timeoutMs}ms timeout]`);
      }, timeoutMs);

      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(output + `\n[exit code ${code}]`);
      });
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        child.kill();
        resolve(output + "\n[aborted]");
      });
    });
  },
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/bash.test.ts`
Expected: `# pass 6`

- [ ] **Step 6: Replace the inline `require("vscode")` in `loop.ts`**

```ts
// src/agent/loop.ts — add at top:
import * as vscode from "vscode";
// and replace:
//   const cfg = require("vscode").workspace.getConfiguration("forge");
// with:
const cfg = vscode.workspace.getConfiguration("forge");
```

Also update the `ToolContext` object built inside `runTurn` to include `requestApproval: ui.requestApproval`.

- [ ] **Step 7: Register bash in `extension.ts`'s temporary dev command**

```ts
import "./tools/bash";
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/tools/bash.ts src/tools/bash.test.ts src/tools/index.ts src/agent/loop.ts src/extension.ts
git commit -m "feat: bash tool with two-mode approval gate"
```

---

### Task 11: Webview markup — `ui/webview/index.html`, `style.css`, `main.js`

**Files:**
- Create: `src/ui/webview/index.html`, `src/ui/webview/style.css`, `src/ui/webview/main.js`

**Interfaces:**
- Consumes (at runtime, via `acquireVsCodeApi().postMessage`): messages of shape `{ type: "userSend", text }`, `{ type: "approve"|"deny", id }`, `{ type: "stop" }`, `{ type: "newSession" }`, `{ type: "selectSession", id }`, `{ type: "toggleApprovalMode" }`, `{ type: "openDiff", file }`, `{ type: "revertFile", file }`.
- Produces (rendered from, via `window.addEventListener("message", ...)`): `{ type: "state", session, streamingText, pendingApproval, touchedFiles, sessionList, approvalMode }` — this is the full-state snapshot `ui/panel.ts` (Task 12) posts after every change.

- [ ] **Step 1: Write `src/ui/webview/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src {{cspSource}} 'nonce-{{nonce}}'; img-src {{cspSource}} data:;" />
<link rel="stylesheet" href="{{styleUri}}" />
<title>Forge</title>
</head>
<body>
  <div id="header">
    <select id="sessionSelect"></select>
    <button id="newSessionBtn" title="New Session">+</button>
    <button id="approvalModeBtn" title="Toggle approval mode">ask</button>
    <button id="stopBtn" title="Stop" disabled>Stop</button>
  </div>
  <div id="messages"></div>
  <div id="touchedFiles"></div>
  <div id="inputBar">
    <textarea id="input" placeholder="Ask Forge..."></textarea>
    <button id="sendBtn">Send</button>
  </div>
  <script nonce="{{nonce}}" src="{{scriptUri}}"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/ui/webview/style.css`**

```css
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; flex-direction: column; height: 100vh; }
#header { display: flex; gap: 4px; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
#header select { flex: 1; min-width: 0; }
#messages { flex: 1; overflow-y: auto; padding: 8px; }
.msg { margin-bottom: 12px; white-space: pre-wrap; word-wrap: break-word; }
.msg.user { color: var(--vscode-textLink-foreground); }
.msg code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
.msg pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; border-radius: 4px; }
.tool-call { cursor: pointer; opacity: 0.8; font-family: var(--vscode-editor-font-family); font-size: 0.9em; margin: 4px 0; }
.tool-call .body { display: none; white-space: pre-wrap; margin-top: 4px; padding: 6px; background: var(--vscode-textCodeBlock-background); }
.tool-call.expanded .body { display: block; }
.approval { border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 8px; margin: 8px 0; }
.approval button { margin-right: 6px; }
#touchedFiles { padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border); font-size: 0.9em; display: none; }
#touchedFiles.visible { display: block; }
#touchedFiles span { cursor: pointer; text-decoration: underline; margin-right: 10px; }
#inputBar { display: flex; padding: 6px; border-top: 1px solid var(--vscode-panel-border); }
#input { flex: 1; resize: none; height: 44px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
```

- [ ] **Step 3: Write `src/ui/webview/main.js`**

```js
const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);

let state = { session: { messages: [] }, streamingText: "", pendingApproval: null, touchedFiles: [], sessionList: [], approvalMode: "ask" };

function renderMarkdown(text) {
  const container = document.createElement("div");
  const lines = text.split("\n");
  let inCode = false;
  let codeBuf = [];
  let listBuf = null;

  function flushList() {
    if (listBuf) { container.appendChild(listBuf); listBuf = null; }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeBuf.join("\n");
        pre.appendChild(code);
        container.appendChild(pre);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (/^#{1,6}\s/.test(line)) {
      flushList();
      const level = line.match(/^#+/)[0].length;
      const h = document.createElement(`h${Math.min(level, 6)}`);
      h.textContent = line.replace(/^#{1,6}\s/, "");
      container.appendChild(h);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      if (!listBuf) listBuf = document.createElement("ul");
      const li = document.createElement("li");
      appendInline(li, line.replace(/^[-*]\s/, ""));
      listBuf.appendChild(li);
      continue;
    }
    flushList();
    if (line.trim() === "") continue;
    const p = document.createElement("p");
    appendInline(p, line);
    container.appendChild(p);
  }
  flushList();
  return container;
}

function appendInline(parent, text) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
    } else if (part.startsWith("**") && part.endsWith("**")) {
      const b = document.createElement("b");
      b.textContent = part.slice(2, -2);
      parent.appendChild(b);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function render() {
  const messagesEl = el("messages");
  messagesEl.innerHTML = "";

  for (const msg of state.session.messages) {
    if (msg.role === "user") {
      const div = document.createElement("div");
      div.className = "msg user";
      div.textContent = msg.content;
      messagesEl.appendChild(div);
    } else if (msg.role === "assistant") {
      if (msg.content) {
        const div = document.createElement("div");
        div.className = "msg assistant";
        div.appendChild(renderMarkdown(msg.content));
        messagesEl.appendChild(div);
      }
      for (const call of msg.tool_calls ?? []) {
        const div = document.createElement("div");
        div.className = "tool-call";
        div.textContent = `▸ ${call.function.name} ${call.function.arguments}`;
        const body = document.createElement("div");
        body.className = "body";
        body.textContent = call.function.arguments;
        div.appendChild(body);
        div.addEventListener("click", () => div.classList.toggle("expanded"));
        messagesEl.appendChild(div);
      }
    } else if (msg.role === "tool") {
      const div = document.createElement("div");
      div.className = "tool-call";
      const preview = (msg.content || "").split("\n")[0].slice(0, 80);
      div.textContent = `  └ ${preview}`;
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = msg.content;
      div.appendChild(body);
      div.addEventListener("click", () => div.classList.toggle("expanded"));
      messagesEl.appendChild(div);
    }
  }

  if (state.streamingText) {
    const div = document.createElement("div");
    div.className = "msg assistant";
    div.appendChild(renderMarkdown(state.streamingText));
    messagesEl.appendChild(div);
  }

  if (state.pendingApproval) {
    const div = document.createElement("div");
    div.className = "approval";
    const label = document.createElement("div");
    label.textContent = `Run: ${state.pendingApproval.command}`;
    div.appendChild(label);
    const approveBtn = document.createElement("button");
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => vscode.postMessage({ type: "approve", id: state.pendingApproval.id }));
    const denyBtn = document.createElement("button");
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => vscode.postMessage({ type: "deny", id: state.pendingApproval.id }));
    div.appendChild(approveBtn);
    div.appendChild(denyBtn);
    messagesEl.appendChild(div);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;

  const touchedEl = el("touchedFiles");
  touchedEl.innerHTML = "";
  touchedEl.classList.toggle("visible", state.touchedFiles.length > 0);
  for (const file of state.touchedFiles) {
    const span = document.createElement("span");
    span.textContent = file;
    span.addEventListener("click", () => vscode.postMessage({ type: "openDiff", file }));
    touchedEl.appendChild(span);
  }

  const sel = el("sessionSelect");
  sel.innerHTML = "";
  for (const s of state.sessionList) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.title;
    if (s.id === state.session.id) opt.selected = true;
    sel.appendChild(opt);
  }

  el("approvalModeBtn").textContent = state.approvalMode;
  el("stopBtn").disabled = !state.streaming;
}

el("sendBtn").addEventListener("click", () => {
  const input = el("input");
  if (!input.value.trim()) return;
  vscode.postMessage({ type: "userSend", text: input.value });
  input.value = "";
});
el("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("sendBtn").click();
  }
});
el("newSessionBtn").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
el("stopBtn").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
el("approvalModeBtn").addEventListener("click", () => vscode.postMessage({ type: "toggleApprovalMode" }));
el("sessionSelect").addEventListener("change", (e) => vscode.postMessage({ type: "selectSession", id: e.target.value }));

window.addEventListener("message", (event) => {
  if (event.data.type === "state") {
    state = event.data;
    render();
  }
});

vscode.postMessage({ type: "ready" });
```

- [ ] **Step 4: No automated test** — this is static markup/vanilla JS with no `vscode` module dependency, but its DOM behavior is only meaningfully verified once wired to `panel.ts` in Task 12. Defer verification to Task 12's manual checkpoint.

- [ ] **Step 5: Commit**

```bash
git add src/ui/webview/index.html src/ui/webview/style.css src/ui/webview/main.js
git commit -m "feat: vanilla webview markup, CSS, and message renderer"
```

---

### Task 12: `ui/panel.ts` + `extension.ts` final wiring (M2 checkpoint)

**Files:**
- Create: `src/ui/panel.ts`
- Modify: `src/extension.ts` (remove temporary `forge.runTurn` command, register the webview view provider)

**Interfaces:**
- Consumes: `runTurn`, `UiPort` (Task 9); `createSession` (Task 5); webview message shapes (Task 11).
- Produces: `ForgePanel` (implements `vscode.WebviewViewProvider`), registered against view id `forge.chat`.

- [ ] **Step 1: Write `src/ui/panel.ts`**

```ts
import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { runTurn, type UiPort } from "../agent/loop";
import { createSession, type Session } from "../state/session";

interface PendingApproval {
  id: string;
  command: string;
  resolve: (approved: boolean) => void;
}

export class ForgePanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: Session;
  private streamingText = "";
  private pendingApproval: PendingApproval | null = null;
  private touchedFiles: string[] = [];
  private controller: AbortController | null = null;
  private sessionList: { id: string; title: string }[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {
    this.session = createSession("", "");
    this.sessionList = [{ id: this.session.id, title: "New Session" }];
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "style.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"));
    const htmlUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.html");
    const template = require("node:fs").readFileSync(htmlUri.fsPath, "utf8");
    return template
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{styleUri}}", styleUri.toString())
      .replaceAll("{{scriptUri}}", scriptUri.toString());
  }

  private postState() {
    this.view?.webview.postMessage({
      type: "state",
      session: this.session,
      streamingText: this.streamingText,
      streaming: this.controller !== null,
      pendingApproval: this.pendingApproval ? { id: this.pendingApproval.id, command: this.pendingApproval.command } : null,
      touchedFiles: this.touchedFiles,
      sessionList: this.sessionList,
      approvalMode: vscode.workspace.getConfiguration("forge").get<string>("approvalMode", "ask"),
    });
  }

  private async handleMessage(msg: any) {
    switch (msg.type) {
      case "ready":
        this.postState();
        break;
      case "userSend":
        await this.startTurn(msg.text);
        break;
      case "approve":
      case "deny":
        if (this.pendingApproval?.id === msg.id) {
          this.pendingApproval.resolve(msg.type === "approve");
          this.pendingApproval = null;
          this.postState();
        }
        break;
      case "stop":
        this.controller?.abort();
        break;
      case "newSession":
        this.session = createSession("", "");
        this.sessionList.push({ id: this.session.id, title: "New Session" });
        this.touchedFiles = [];
        this.postState();
        break;
      case "toggleApprovalMode": {
        const cfg = vscode.workspace.getConfiguration("forge");
        const current = cfg.get<string>("approvalMode", "ask");
        await cfg.update("approvalMode", current === "ask" ? "auto" : "ask", vscode.ConfigurationTarget.Workspace);
        this.postState();
        break;
      }
      case "openDiff":
        vscode.commands.executeCommand("forge.openDiff", msg.file);
        break;
      case "revertFile":
        vscode.commands.executeCommand("forge.revertFile", msg.file);
        break;
    }
  }

  private async startTurn(text: string) {
    this.streamingText = "";
    this.touchedFiles = [];
    this.controller = new AbortController();
    this.postState();

    const ui: UiPort = {
      streamAssistantText: (delta) => {
        this.streamingText += delta;
        this.postState();
      },
      requestApproval: (command) =>
        new Promise<boolean>((resolve) => {
          this.pendingApproval = { id: crypto.randomBytes(4).toString("hex"), command, resolve };
          this.postState();
        }),
      showTurnDiff: (files) => {
        this.touchedFiles = files;
        this.postState();
      },
      showError: (message) => {
        vscode.window.showErrorMessage(`Forge: ${message}`);
      },
    };

    await runTurn(this.session, text, ui, this.controller.signal);

    this.streamingText = "";
    this.controller = null;
    this.postState();
  }
}
```

- [ ] **Step 2: Rewrite `src/extension.ts`** to register the webview instead of the temporary debug command

```ts
import * as vscode from "vscode";
import { chat } from "./aicore/client";
import { ForgePanel } from "./ui/panel";
import "./tools/readFile";
import "./tools/listDir";
import "./tools/grep";
import "./tools/searchReplace";
import "./tools/bash";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Forge");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.ping", async () => {
      output.show(true);
      output.appendLine("Sending: say hello");
      try {
        const reply = await chat([{ role: "user", content: "say hello" }], [], (delta) => output.append(delta));
        output.appendLine("");
        output.appendLine(`[done] finish content length: ${(reply.content ?? "").length}`);
      } catch (err) {
        output.appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  const panel = new ForgePanel(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("forge.chat", panel));

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.newSession", () => {
      vscode.commands.executeCommand("workbench.view.extension.forge");
    }),
  );
}

export function deactivate() {}
```

- [ ] **Step 3: Make esbuild copy the webview assets alongside the bundle**

```js
// esbuild.mjs — add after the extension bundle build, before process exit:
import * as fs from "node:fs";

fs.mkdirSync("dist/webview", { recursive: true });
for (const file of ["index.html", "style.css", "main.js"]) {
  fs.copyFileSync(`src/ui/webview/${file}`, `dist/webview/${file}`);
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors; `dist/webview/{index.html,style.css,main.js}` exist.

- [ ] **Step 5: Manual verification (M2 checkpoint, spec §12 acceptance tests 1–3)**

1. `F5` to launch the Extension Development Host. Open the Forge icon in the activity bar — the chat view should render with header, empty message list, and input box.
2. **Acceptance test 1**: Type "What does this repo do?" and send. Expected: streamed assistant text appears live; tool calls render as collapsed `▸ list_dir ...` / `▸ read_file ...` lines that expand on click; no approval prompts appear (read-only tools never gate); final answer is concise.
3. **Acceptance test 3**: Ask something requiring a command, e.g. "run the tests," with `forge.approvalMode` = `ask`. Expected: an inline approval card appears with the exact command and Approve/Deny buttons. Click Deny — expected: the transcript shows `User denied this command.` as the tool result, and the model reacts (re-plans or asks the user) without the extension crashing. Re-ask and click Approve — expected: command output appears (or `[truncated]` markers if very long).
4. Click Stop mid-turn on a long-running request — expected: the turn ends promptly, the Stop button disables, and a subsequent message still works (session isn't corrupted).
5. Do not proceed to Task 13 until steps 2–4 all pass in the real UI.

- [ ] **Step 6: Commit**

```bash
git add src/ui/panel.ts src/extension.ts esbuild.mjs package.json
git commit -m "feat: webview chat panel with approvals and stop (M2 checkpoint)"
```

---

### Task 13: `state/diffTracker.ts` (real implementation) + `forge-before` content provider

**Files:**
- Modify: `src/state/diffTracker.ts` (replace the Task 8 stub), `src/tools/searchReplace.ts` (call `beginTurn`/real `snapshot`), `src/tools/bash.ts` (record touched files via `git diff --name-only` fallback), `src/agent/loop.ts` (call `diffTracker.beginTurn()`/`endTurn()` and `ui.showTurnDiff`)
- Create: `src/state/diffTracker.test.ts`

**Interfaces:**
- Produces: `diffTracker.beginTurn(): void`; `diffTracker.snapshot(filePath: string, contentBefore: string | null): void`; `diffTracker.endTurn(): string[]`; `diffTracker.getSnapshot(filePath: string): string | null | undefined` (undefined = never snapshotted, null = file was newly created); registers `forge-before` as a `vscode.TextDocumentContentProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// src/state/diffTracker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiffTracker } from "./diffTracker";

test("snapshot only records the first write to a file per turn", () => {
  const dt = createDiffTracker();
  dt.beginTurn();
  dt.snapshot("a.ts", "original");
  dt.snapshot("a.ts", "intermediate-should-be-ignored");
  assert.equal(dt.getSnapshot("a.ts"), "original");
});

test("endTurn returns all touched files and beginTurn clears them", () => {
  const dt = createDiffTracker();
  dt.beginTurn();
  dt.snapshot("a.ts", "x");
  dt.snapshot("b.ts", null);
  assert.deepEqual(dt.endTurn().sort(), ["a.ts", "b.ts"]);
  dt.beginTurn();
  assert.deepEqual(dt.endTurn(), []);
});

test("getSnapshot distinguishes untouched (undefined) from newly-created (null)", () => {
  const dt = createDiffTracker();
  dt.beginTurn();
  dt.snapshot("new.ts", null);
  assert.equal(dt.getSnapshot("new.ts"), null);
  assert.equal(dt.getSnapshot("never-touched.ts"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './diffTracker'` exporting `createDiffTracker` (current stub only exports `diffTracker`).

- [ ] **Step 3: Write `src/state/diffTracker.ts`**

```ts
export interface DiffTracker {
  beginTurn(): void;
  snapshot(filePath: string, contentBefore: string | null): void;
  endTurn(): string[];
  getSnapshot(filePath: string): string | null | undefined;
}

export function createDiffTracker(): DiffTracker {
  let snapshots = new Map<string, string | null>();

  return {
    beginTurn() {
      snapshots = new Map();
    },
    snapshot(filePath, contentBefore) {
      if (!snapshots.has(filePath)) {
        snapshots.set(filePath, contentBefore);
      }
    },
    endTurn() {
      return [...snapshots.keys()];
    },
    getSnapshot(filePath) {
      return snapshots.get(filePath);
    },
  };
}

export const diffTracker = createDiffTracker();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/state/diffTracker.test.ts`
Expected: `# pass 3`

- [ ] **Step 5: Wire `beginTurn`/`endTurn` into `src/agent/loop.ts`**

```ts
// add import
import { diffTracker } from "../state/diffTracker";

// at the start of runTurn, right after pushing the user message:
diffTracker.beginTurn();

// replace the MAX_STEPS-exhausted branch's fallthrough and the normal return points
// so that showTurnDiff is always called before runTurn returns. Wrap the existing
// for-loop body: after it returns/exits (including the tool_calls-empty early return
// and the catch block), call:
ui.showTurnDiff(diffTracker.endTurn());
```

Concretely, restructure `runTurn`'s control flow to funnel through one exit point:

```ts
export async function runTurn(session: Session, userText: string, ui: UiPort, signal: AbortSignal): Promise<void> {
  session.messages.push({ role: "user", content: userText });
  appendToStore(session, { role: "user", content: userText });
  diffTracker.beginTurn();

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;

      const cfg = vscode.workspace.getConfiguration("forge");
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
          requestApproval: ui.requestApproval,
        });
        const msg = { role: "tool" as const, tool_call_id: call.id, content: result };
        session.messages.push(msg);
        appendToStore(session, msg);
      }
    }
    ui.showError(`Step budget (${MAX_STEPS}) exhausted for this turn.`);
  } catch (err) {
    ui.showError(err instanceof Error ? err.message : String(err));
  } finally {
    ui.showTurnDiff(diffTracker.endTurn());
  }
}
```

- [ ] **Step 6: Wire real snapshotting into `src/tools/searchReplace.ts`**

```ts
// replace the stub import
import { diffTracker } from "../state/diffTracker";
// the existing call `diffTracker.snapshot(args.file_path, current);` now records real content
```

- [ ] **Step 7: Record bash-touched files via `git diff --name-only`**

Per spec §5: "for bash edits, fall back to `git diff` display" — bash doesn't get exact before/after snapshots, only a listing. Add to `src/tools/bash.ts`:

```ts
// after the command finishes successfully (in the `child.on("close", ...)` handler,
// before resolving), best-effort record any git-visible changes:
import { execSync } from "node:child_process";
import { diffTracker } from "../state/diffTracker";

function recordGitTouchedFiles(workspaceRoot: string) {
  try {
    const out = execSync("git diff --name-only", { cwd: workspaceRoot, encoding: "utf8" });
    for (const file of out.split("\n").filter(Boolean)) {
      diffTracker.snapshot(file, undefined as unknown as string); // marks "touched, no exact before"
    }
  } catch {
    // not a git repo, or git unavailable — silently skip
  }
}
```

Call `recordGitTouchedFiles(ctx.workspaceRoot)` right before each `resolve(...)` call in `bash.ts`'s promise executor. Note: passing `undefined` into `snapshot`'s `contentBefore: string | null` param is a deliberate widening for this "touched but no exact snapshot" case — update `DiffTracker`'s type to `snapshot(filePath: string, contentBefore: string | null | undefined): void` and treat `undefined` in the diff-view command (Task 14) as "show `git diff` for this file instead of the exact before/after".

- [ ] **Step 8: Write the `forge-before` `TextDocumentContentProvider`**

```ts
// add to src/state/diffTracker.ts
import * as vscode from "vscode";

export class BeforeContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly tracker: DiffTracker) {}
  provideTextDocumentContent(uri: vscode.Uri): string {
    const filePath = decodeURIComponent(uri.path);
    const before = this.tracker.getSnapshot(filePath);
    return before ?? "";
  }
}
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/state/diffTracker.ts src/state/diffTracker.test.ts src/tools/searchReplace.ts src/tools/bash.ts src/agent/loop.ts
git commit -m "feat: real diff tracking (search_replace snapshots + bash git-diff fallback)"
```

---

### Task 14: Touched-files bar wiring — diff view command + revert command

**Files:**
- Modify: `src/extension.ts` (register `forge.openDiff`, `forge.revertFile`, the `forge-before` provider)

**Interfaces:**
- Consumes: `BeforeContentProvider`, `diffTracker` (Task 13).
- Produces: commands `forge.openDiff` (file: string), `forge.revertFile` (file: string) invoked from the webview via `ui/panel.ts`'s `openDiff`/`revertFile` message handlers (already wired in Task 12).

- [ ] **Step 1: Register the provider and commands in `src/extension.ts`**

```ts
import { diffTracker, BeforeContentProvider } from "./state/diffTracker";
import * as path from "node:path";
import * as fs from "node:fs";

// inside activate():
const beforeProvider = new BeforeContentProvider(diffTracker);
context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("forge-before", beforeProvider));

context.subscriptions.push(
  vscode.commands.registerCommand("forge.openDiff", async (file: string) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const before = diffTracker.getSnapshot(file);
    if (before === undefined) {
      vscode.window.showInformationMessage(`Forge: ${file} was changed by a shell command — showing git diff instead.`);
      await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(path.join(root, file)));
      return;
    }
    const beforeUri = vscode.Uri.parse(`forge-before:${encodeURIComponent(file)}`);
    const afterUri = vscode.Uri.file(path.join(root, file));
    await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `Forge: ${file} (this turn)`);
  }),
);

context.subscriptions.push(
  vscode.commands.registerCommand("forge.revertFile", async (file: string) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const before = diffTracker.getSnapshot(file);
    const abs = path.join(root, file);
    const uri = vscode.Uri.file(abs);
    const edit = new vscode.WorkspaceEdit();
    if (before === null) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
    } else if (typeof before === "string") {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, fullRange, before);
    } else {
      vscode.window.showWarningMessage(`Forge: no exact snapshot for ${file} (changed by a shell command) — cannot auto-revert.`);
      return;
    }
    await vscode.workspace.applyEdit(edit);
    if (before !== null) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
    }
  }),
);
```

- [ ] **Step 2: Add a "Revert file" affordance to the webview**

Modify `src/ui/webview/main.js`'s touched-files rendering: add a small revert control per file.

```js
// in render(), inside the `for (const file of state.touchedFiles)` loop, replace the span-only block with:
const row = document.createElement("span");
const nameSpan = document.createElement("a");
nameSpan.textContent = file;
nameSpan.addEventListener("click", () => vscode.postMessage({ type: "openDiff", file }));
const revertBtn = document.createElement("button");
revertBtn.textContent = "revert";
revertBtn.addEventListener("click", () => vscode.postMessage({ type: "revertFile", file }));
row.appendChild(nameSpan);
row.appendChild(revertBtn);
touchedEl.appendChild(row);
```

(Remove the old `const span = document.createElement("span"); span.textContent = file; ...` block it replaces.)

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Manual verification (spec §12 acceptance test 2)**

1. `F5`. Ask: "Rename function A to B everywhere" against a real multi-file repo with a real function to rename.
2. Expected: agent greps for usages, edits multiple files via `search_replace`, and the touched-files bar lists every changed file after the turn.
3. Click a filename — expected: `vscode.diff` opens showing before/after correctly (before = original content via `forge-before:`, after = the live file).
4. Click "revert" on one file — expected: that file's content is restored to pre-turn state and the change is visible in the editor; other touched files are unaffected.
5. Do not proceed until diff view and revert both work correctly on real edits.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/ui/webview/main.js
git commit -m "feat: diff view and per-file revert for touched files"
```

---

### Task 15: `state/store.ts` (JSONL persistence)

**Files:**
- Modify: `src/state/store.ts` (replace the Task 9 stub)
- Create: `src/state/store.test.ts`

**Interfaces:**
- Produces: `appendToStore(session: Session, message: Message): void`; `listSessions(workspaceRoot: string): { id: string; title: string; filePath: string }[]`; `loadSession(filePath: string): Session`; `newSessionFilePath(workspaceRoot: string, session: Session): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/state/store.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendToStore, listSessions, loadSession, newSessionFilePath } from "./store";
import { createSession } from "./session";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-store-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendToStore creates the file with a meta line then appends messages", () => {
  const session = createSession("hello world", "gpt-4o");
  session.filePath = newSessionFilePath(dir, session);
  appendToStore(session, { role: "user", content: "hello world" });
  appendToStore(session, { role: "assistant", content: "hi there" });

  const lines = fs.readFileSync(session.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "meta");
  assert.equal(lines[0].title, "hello world");
  assert.equal(lines[1].role, "user");
  assert.equal(lines[2].role, "assistant");
});

test("listSessions finds sessions under .forge/sessions and reads their titles", () => {
  const session = createSession("second session", "gpt-4o");
  session.filePath = newSessionFilePath(dir, session);
  appendToStore(session, { role: "user", content: "second session" });

  const sessions = listSessions(dir);
  assert.ok(sessions.some((s) => s.title === "second session"));
});

test("loadSession reconstructs the full message list", () => {
  const session = createSession("third", "gpt-4o");
  session.filePath = newSessionFilePath(dir, session);
  appendToStore(session, { role: "user", content: "third" });
  appendToStore(session, { role: "assistant", content: "reply" });

  const loaded = loadSession(session.filePath);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[1].content, "reply");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: current stub only exports `appendToStore(session, message)` with a no-op body and no other exports — `listSessions`/`loadSession`/`newSessionFilePath` are missing.

- [ ] **Step 3: Write `src/state/store.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { Session } from "./session";
import type { Message } from "../aicore/types";

function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".forge", "sessions");
}

export function newSessionFilePath(workspaceRoot: string, session: Session): string {
  const dir = sessionsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.createdAt.replace(/[:.]/g, "-")}-${session.id}.jsonl`);
  fs.writeFileSync(filePath, JSON.stringify({ type: "meta", title: session.title, createdAt: session.createdAt, model: session.model }) + "\n");
  return filePath;
}

export function appendToStore(session: Session, message: Message): void {
  if (!session.filePath) return;
  fs.appendFileSync(session.filePath, JSON.stringify(message) + "\n");
}

export function listSessions(workspaceRoot: string): { id: string; title: string; filePath: string }[] {
  const dir = sessionsDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files
    .map((f) => {
      const filePath = path.join(dir, f);
      const firstLine = fs.readFileSync(filePath, "utf8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      const id = f.split("-").pop()!.replace(".jsonl", "");
      return { id, title: meta.title || "(untitled)", filePath };
    })
    .sort((a, b) => b.filePath.localeCompare(a.filePath));
}

export function loadSession(filePath: string): Session {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const meta = JSON.parse(lines[0]);
  const messages: Message[] = [];
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line);
    if (parsed.type === "compaction") continue;
    messages.push(parsed);
  }
  const id = path.basename(filePath).split("-").pop()!.replace(".jsonl", "");
  return { id, title: meta.title, createdAt: meta.createdAt, model: meta.model, messages, filePath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/state/store.test.ts`
Expected: `# pass 3`

- [ ] **Step 5: Assign `filePath` when creating a session, in `ui/panel.ts`**

```ts
// in ForgePanel, wherever `createSession(...)` is called (constructor and "newSession" handler),
// immediately follow it with:
this.session.filePath = newSessionFilePath(getWorkspaceRoot(), this.session);
```

Import `newSessionFilePath` from `../state/store` and `getWorkspaceRoot` from `../tools/index`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/state/store.ts src/state/store.test.ts src/ui/panel.ts
git commit -m "feat: JSONL session persistence under .forge/sessions"
```

---

### Task 16: Session dropdown UI wiring (M3 checkpoint)

**Files:**
- Modify: `src/ui/panel.ts` (populate `sessionList` from `listSessions`, handle `selectSession`)

**Interfaces:**
- Consumes: `listSessions`, `loadSession` (Task 15).

- [ ] **Step 1: Update `ForgePanel` in `src/ui/panel.ts`**

```ts
// add imports
import { listSessions, loadSession, newSessionFilePath } from "../state/store";
import { getWorkspaceRoot } from "../tools/index";

// replace the constructor body:
constructor(private readonly extensionUri: vscode.Uri) {
  const root = getWorkspaceRoot();
  this.sessionList = listSessions(root).map(({ id, title }) => ({ id, title }));
  this.session = createSession("", "");
  this.session.filePath = newSessionFilePath(root, this.session);
  this.sessionList.unshift({ id: this.session.id, title: "New Session" });
}

// replace the "newSession" case body:
case "newSession": {
  const root = getWorkspaceRoot();
  this.session = createSession("", "");
  this.session.filePath = newSessionFilePath(root, this.session);
  this.sessionList.unshift({ id: this.session.id, title: "New Session" });
  this.touchedFiles = [];
  this.postState();
  break;
}

// add a new case:
case "selectSession": {
  const root = getWorkspaceRoot();
  const entry = listSessions(root).find((s) => s.id === msg.id);
  if (entry) {
    this.session = loadSession(entry.filePath);
    this.touchedFiles = [];
    this.postState();
  }
  break;
}
```

- [ ] **Step 2: Update session titles after the first user message**

The title is set to `""` at session creation (spec §8 says title = first user message, 60 chars). Add, inside `startTurn` right before `diffTracker`/`runTurn` is invoked:

```ts
if (!this.session.title) {
  this.session.title = text.slice(0, 60);
  const entry = this.sessionList.find((s) => s.id === this.session.id);
  if (entry) entry.title = this.session.title;
}
```

Note this only updates the in-memory title; the `meta` line already written to disk by `newSessionFilePath` at session creation has the stale `""` title. Fix `newSessionFilePath` in `store.ts` (Task 15) to not require a title at creation time — instead, add a `updateSessionTitle(filePath: string, title: string)` helper:

```ts
// add to src/state/store.ts
export function updateSessionTitle(filePath: string, title: string): void {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const meta = JSON.parse(lines[0]);
  meta.title = title;
  lines[0] = JSON.stringify(meta);
  fs.writeFileSync(filePath, lines.join("\n"));
}
```

Call it from the same `if (!this.session.title)` block in `panel.ts`: `updateSessionTitle(this.session.filePath!, this.session.title);`.

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Manual verification (M3 checkpoint, spec §12 acceptance test 6)**

1. `F5`. Have one full conversation turn, then close the Extension Development Host window entirely (not just reload).
2. Re-launch (`F5` again, or reopen the workspace in the dev host). Open Forge — expected: the session dropdown lists the prior session by its first-message title.
3. Select it — expected: the full prior transcript renders read-only-looking but is actually loaded as the active session (per spec §8, "Continue this session" — for v1 simplicity, selecting IS continuing, since there's only one webview and one active session at a time).
4. Send a new message in the continued session — expected: it appends correctly and the turn completes.
5. Inspect `.forge/sessions/*.jsonl` on disk — expected: valid JSONL, one meta line + one line per message, human-readable.

- [ ] **Step 5: Commit**

```bash
git add src/ui/panel.ts src/state/store.ts
git commit -m "feat: session dropdown with load/continue (M3 checkpoint)"
```

---

### Task 17: `agent/compaction.ts` (real implementation)

**Files:**
- Modify: `src/agent/compaction.ts` (replace the Task 9 stub)
- Create: `src/agent/compaction.test.ts`

**Interfaces:**
- Consumes: `chat` (Task 3), `Session` (Task 5).
- Produces: `compact(session: Session, chatFn?: typeof chat): Promise<void>` — takes an optional injected `chat` function so the summarization call can be mocked in tests without a real network dependency.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/compaction.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { compact } from "./compaction";
import type { Session } from "../state/session";

test("compact replaces the transcript with a summary + last user message, keeping full history on disk separately", async () => {
  const session: Session = {
    id: "1",
    title: "t",
    createdAt: "now",
    model: "m",
    messages: [
      { role: "user", content: "build feature X" },
      { role: "assistant", content: "ok, exploring" },
      { role: "tool", content: "file contents...", tool_call_id: "c1" },
      { role: "assistant", content: "done with step 1" },
      { role: "user", content: "now add tests" },
    ],
  };

  const fakeChat = async (_messages: any, _tools: any, onDelta: (t: string) => void) => {
    onDelta("Summary: implemented X, next add tests.");
    return { role: "assistant" as const, content: "Summary: implemented X, next add tests." };
  };

  await compact(session, fakeChat);

  assert.equal(session.messages.length, 2);
  assert.match(session.messages[0].content!, /^\[Session summary\]/);
  assert.match(session.messages[0].content!, /implemented X/);
  assert.equal(session.messages[1].content, "now add tests");
});

test("compact appends a compaction marker line to the session's JSONL file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-"));
  const filePath = path.join(dir, "s.jsonl");
  fs.writeFileSync(filePath, JSON.stringify({ type: "meta", title: "t" }) + "\n");

  const session: Session = {
    id: "1",
    title: "t",
    createdAt: "now",
    model: "m",
    filePath,
    messages: [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ],
  };
  const fakeChat = async () => ({ role: "assistant" as const, content: "summary text" });

  await compact(session, fakeChat);

  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === "compaction"));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: current stub's `compact(session)` signature doesn't accept a second `chatFn` argument.

- [ ] **Step 3: Write `src/agent/compaction.ts`**

```ts
import * as fs from "node:fs";
import { chat as realChat } from "../aicore/client";
import type { Session } from "../state/session";

const COMPACTION_PROMPT = `Summarize this coding session so a fresh agent can continue seamlessly. Include:
the user's overall goal; all decisions made; every file created or modified and
how; current state of the task; unresolved problems; exact next steps. Output
plain text, max 800 words.`;

export async function compact(session: Session, chatFn: typeof realChat = realChat): Promise<void> {
  const lastUserMessage = [...session.messages].reverse().find((m) => m.role === "user");

  const transcriptForSummary = [...session.messages, { role: "user" as const, content: COMPACTION_PROMPT }];
  const summaryMsg = await chatFn(transcriptForSummary, [], () => {});
  const summary = summaryMsg.content ?? "(no summary produced)";

  if (session.filePath) {
    fs.appendFileSync(session.filePath, JSON.stringify({ type: "compaction" }) + "\n");
  }

  session.messages = [
    { role: "user", content: `[Session summary]\n${summary}` },
    ...(lastUserMessage ? [lastUserMessage] : []),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/agent/compaction.test.ts`
Expected: `# pass 2`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `agent/loop.ts`'s `await compact(session)` call — one-arg form — still matches the new signature since `chatFn` has a default).

- [ ] **Step 6: Manual verification (spec §12 acceptance test 5)**

1. Set `forge.contextBudget` to `2000` in workspace settings.
2. `F5`. Have a multi-turn conversation that involves a few tool calls (enough to exceed ~1500 estimated tokens).
3. Expected: at some point mid-turn, the transcript visibly resets to a short summary message before the next assistant reply — the conversation should still continue coherently (the model should still know what it was doing).
4. Inspect the session's `.jsonl` file on disk — expected: it still contains every original message plus a `{"type":"compaction"}` marker line; nothing was deleted from disk, only from the in-memory/live context.

- [ ] **Step 7: Commit**

```bash
git add src/agent/compaction.ts src/agent/compaction.test.ts
git commit -m "feat: context compaction via model-generated summary"
```

---

### Task 18: `AGENTS.md`/`CLAUDE.md` injection into the system prompt

**Files:**
- Modify: `src/agent/agentsMd.ts` (replace the Task 9 stub)
- Create: `src/agent/agentsMd.test.ts`

**Interfaces:**
- Produces: `loadAgentsMd(workspaceRoot: string): string` — returns either `""` (no file found) or the formatted `Project instructions (AGENTS.md):\n...` block, capped at 8,000 characters, consumed by `systemPrompt.ts` (already wired in Task 9).

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/agentsMd.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentsMd } from "./agentsMd";

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-agentsmd-")); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test("returns empty string when neither file exists", () => {
  assert.equal(loadAgentsMd(dir), "");
});

test("reads AGENTS.md and wraps it under the heading", () => {
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Use 2-space indent.");
  const out = loadAgentsMd(dir);
  assert.match(out, /^Project instructions \(AGENTS\.md\):\n/);
  assert.match(out, /Use 2-space indent\./);
});

test("falls back to CLAUDE.md when AGENTS.md is absent", () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-agentsmd2-"));
  fs.writeFileSync(path.join(dir2, "CLAUDE.md"), "Prefer functional style.");
  const out = loadAgentsMd(dir2);
  assert.match(out, /Prefer functional style\./);
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("caps content at 8000 characters", () => {
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "x".repeat(9000));
  const out = loadAgentsMd(dir);
  const body = out.replace("Project instructions (AGENTS.md):\n", "");
  assert.equal(body.length, 8000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: current stub always returns `""`, tests 2–4 fail.

- [ ] **Step 3: Write `src/agent/agentsMd.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";

const CAP = 8_000;

export function loadAgentsMd(workspaceRoot: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(workspaceRoot, name);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8").slice(0, CAP);
      return `Project instructions (AGENTS.md):\n${content}`;
    }
  }
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/agent/agentsMd.test.ts`
Expected: `# pass 4`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agentsMd.ts src/agent/agentsMd.test.ts
git commit -m "feat: inject AGENTS.md/CLAUDE.md into the system prompt"
```

---

### Task 19: Error toasts on network failure + Windows shell verification (M4 checkpoint, spec §12 acceptance test 4)

**Files:**
- Modify: `src/ui/panel.ts` (surface `showError` as both an inline transcript entry and a toast — already calls `vscode.window.showErrorMessage`, verify it also keeps the session usable)

**Interfaces:**
- No new interfaces — this task is verification-and-hardening of existing wiring from Tasks 9, 10, 12.

- [ ] **Step 1: Confirm `UiPort.showError` in `panel.ts` doesn't leave `this.controller` dangling**

Read `startTurn` in `src/ui/panel.ts`. Confirm the sequence is: `await runTurn(...)` → `this.controller = null` → `this.postState()` runs unconditionally after `runTurn` resolves, even when `runTurn` internally caught an error and called `ui.showError`. Since `runTurn`'s `try/catch/finally` (Task 13) always completes normally (the `catch` swallows the error into `ui.showError`, `finally` always runs `showTurnDiff`), `runTurn` never throws out to `panel.ts` — so `startTurn`'s post-`await` cleanup always executes. No code change should be needed if Tasks 9/13 were implemented as specified; if `runTurn` was left able to throw, fix it now so it can't.

- [ ] **Step 2: Manual verification — kill network mid-turn (acceptance test 4)**

1. `F5`. Start a turn that will take a few seconds (ask for something requiring multiple tool calls).
2. Mid-turn, disconnect the machine's network (Wi-Fi off) or block the SAP AI Core host in `/etc/hosts`.
3. Expected: within the retry/backoff window (spec §2.2: 3 retries, up to ~7s of backoff) the `chat()` call ultimately throws; `runTurn`'s catch calls `ui.showError`, which shows a VS Code error toast AND the session remains intact (previous messages still in the webview, input box still usable).
4. Reconnect the network. Send a new message in the same session. Expected: it completes normally — confirms the failed turn didn't corrupt `session.messages` or the JSONL file (a message was appended for the user turn and the assistant reply if partial, but nothing is malformed — verify by re-reading the `.jsonl` file: every line must be valid JSON).

- [ ] **Step 3: Manual verification — Windows PowerShell path (spec §4.5)**

If a Windows machine or VM is available: repeat the bash-tool acceptance test 3 flow there. Expected: `bash.ts`'s `os.platform() === "win32"` branch spawns via `powershell.exe` and command output/exit codes are captured the same way as on macOS/Linux. If no Windows machine is available, at minimum confirm by code inspection that `src/tools/bash.ts`'s `spawn(command, { shell: isWin ? "powershell.exe" : true, ... })` branch is reachable and that `timeout_ms` capping (`Math.min(300_000, ...)`) applies identically on both platforms — note in the plan's completion notes that live Windows verification is outstanding if untested.

- [ ] **Step 4: Manual verification — path escape refusal (spec §12 acceptance test 7)**

1. `F5`. Ask: "edit the file at ../foo to add a comment."
2. Expected: the `search_replace` (or `read_file`) tool call returns `Error: Path escapes workspace root: ../foo` as the tool result (per `resolveWithinRoot` in Task 6), the model relays that it can't do this, and no file outside the workspace is touched.

- [ ] **Step 5: Commit** (only if Step 1 required a code change; otherwise this task has no diff to commit — skip)

---

### Task 20: Final polish, full manual acceptance pass, and packaging

**Files:**
- No new files expected; fix whatever the acceptance pass turns up.

**Interfaces:**
- None — this is the closing verification task.

- [ ] **Step 1: Run the full automated test suite**

Run: `npm run test`
Expected: every `*.test.ts` file passes (auth, sse, tokens, tools/index, readFile, grep, searchReplace, bash, diffTracker, store, compaction, agentsMd).

- [ ] **Step 2: Typecheck and build clean**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors, `dist/extension.js` and `dist/webview/*` present.

- [ ] **Step 3: Run every acceptance test from spec §12 in one sitting, in a real Extension Development Host, against a real SAP AI Core deployment**

1. "What does this repo do?" → list_dir/read_file only, no edits, no approval prompts. *(re-verify from Task 12)*
2. "Rename function A to B everywhere" → multi-file search_replace edits, touched-files bar accurate, diff view correct, revert restores one file. *(re-verify from Task 14)*
3. "Run the tests" in `ask` mode → approval prompt, Deny handled gracefully, Approve captures/truncates output. *(re-verify from Task 12)*
4. Kill network mid-turn → error toast, session intact, next message works. *(re-verify from Task 19)*
5. `forge.contextBudget` = 2000 → compaction fires, session stays coherent, JSONL retains full history. *(re-verify from Task 17)*
6. Reload the VS Code window → previous session in dropdown, continuable. *(re-verify from Task 16)*
7. Edit a file outside the workspace (`../foo`) → tool refuses. *(re-verify from Task 19)*

Expected: all 7 pass without code changes. If any fail, fix the responsible task's code, re-run its unit tests, then re-run this full pass from Step 1.

- [ ] **Step 4: Package the extension**

```bash
npx vsce package
```

Expected: a `forge-0.0.1.vsix` file is produced with no errors (vsce may warn about a missing `LICENSE`/`repository` field — acceptable for internal use, not a blocker).

- [ ] **Step 5: Install and smoke-test from the packaged VSIX**

1. In VS Code: Extensions view → "..." menu → "Install from VSIX..." → select `forge-0.0.1.vsix`.
2. Reload VS Code, open a real workspace, configure `forge.*` settings, run acceptance test 1 again from the installed (non-dev-host) extension.
3. Expected: identical behavior to the dev host.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: final acceptance pass and v0.0.1 packaging"
```

---

## Self-Review Notes

**Spec coverage check:** every numbered section of the spec (§0 hard constraints → Global Constraints; §1 layout → File Structure + one task per file; §2 auth/client → Tasks 2–3; §3 loop → Tasks 9, 13; §4 five tools → Tasks 6–8, 10; §5 diff tracking → Tasks 13–14; §6 compaction → Task 17; §7 system prompt → Tasks 9, 18; §8 persistence → Tasks 15–16; §9 webview → Tasks 11–12; §10 package.json → Task 1; §11 milestone order → M0/M1/M2/M3/M4 checkpoints embedded in Tasks 4, 9, 12, 16, 19–20; §12 acceptance tests → explicitly re-run in Task 20 Step 3; §13 non-goals → deliberately not built) is covered by at least one task.

**Known deviations from the literal spec text**, called out where introduced above:
1. `aicore/sse.ts` added as an internal, `vscode`-free helper module (Task 3) so SSE parsing is unit-testable — no behavioral change to `client.ts`'s public `chat()` contract.
2. `ToolContext` (Task 6) gains a `requestApproval` field not explicit in the spec's tool-schema tables, needed because `bash.ts` (Task 10) must call back into the UI for approval — this is the natural implementation of spec §4.5's approval gate, not a scope change.
3. Temporary stub files (`diffTracker.ts` in Task 8, `compaction.ts`/`store.ts`/`agentsMd.ts` in Task 9) exist only to let earlier tasks typecheck before their real implementations land in later tasks (13, 17, 15, 18 respectively) — every stub is fully replaced before the plan ends, and no stub ships in the Task 20 package step.
