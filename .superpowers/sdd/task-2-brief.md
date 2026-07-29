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

