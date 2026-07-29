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

