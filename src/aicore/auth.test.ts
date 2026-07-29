import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getToken, invalidateToken } from "./auth.ts";
import type { ServiceKey } from "./types.ts";

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
