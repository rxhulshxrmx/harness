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

