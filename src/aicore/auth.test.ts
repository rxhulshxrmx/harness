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

test("a 401 names the credential fields to check", async () => {
  mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401, text: async () => "" }) as Response);
  await assert.rejects(() => getToken(key), /Client ID and Client secret/);
  mock.reset();
});

test("a 404 blames the auth URL rather than the credentials", async () => {
  mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404, text: async () => "" }) as Response);
  await assert.rejects(() => getToken(key), /No OAuth endpoint at https:\/\/auth\.example\.com\/oauth\/token/);
  mock.reset();
});

test("other failures carry the status and a trimmed body", async () => {
  mock.method(
    globalThis,
    "fetch",
    async () => ({ ok: false, status: 500, text: async () => "  upstream\n  exploded  " }) as Response,
  );
  await assert.rejects(() => getToken(key), /Token request failed: 500 upstream exploded/);
  mock.reset();
});

test("an unreachable auth URL reports the host, not a bare fetch failure", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("getaddrinfo ENOTFOUND auth.example.com");
  });
  await assert.rejects(() => getToken(key), /Could not reach the auth URL \(https:\/\/auth\.example\.com\)/);
  mock.reset();
});

test("a 200 with no access_token is treated as the wrong kind of endpoint", async () => {
  mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ hello: "world" }) }) as Response);
  await assert.rejects(() => getToken(key), /returned no access_token/);
  mock.reset();
});

test("changing credentials does not reuse the previous token", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) } as Response;
  });

  await getToken(key);
  const other = await getToken({ ...key, clientid: "different-id" });

  assert.equal(calls, 2, "a different client id must mint its own token");
  assert.equal(other, "tok-2");
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
