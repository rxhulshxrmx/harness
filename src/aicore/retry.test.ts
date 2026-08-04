import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRetry, MAX_BACKOFF_ATTEMPTS } from "./retry.ts";

const fresh = { attempt: 0, triedTokenRefresh: false, triedDeploymentReresolve: false };

test("a 2xx proceeds to reading the stream", () => {
  for (const status of [200, 201, 299]) {
    assert.deepEqual(decideRetry(status, fresh), { action: "proceed" });
  }
});

test("a 401 refreshes the token once, then gives up", () => {
  assert.deepEqual(decideRetry(401, fresh), { action: "refresh-token" });
  assert.deepEqual(decideRetry(401, { ...fresh, triedTokenRefresh: true }), { action: "fail" });
});

test("a 404 re-resolves the deployment once, then gives up", () => {
  assert.deepEqual(decideRetry(404, fresh), { action: "reresolve-deployment" });
  assert.deepEqual(decideRetry(404, { ...fresh, triedDeploymentReresolve: true }), { action: "fail" });
});

test("re-resolving a deployment does not consume the token retry, or the reverse", () => {
  assert.deepEqual(decideRetry(401, { ...fresh, triedDeploymentReresolve: true }), { action: "refresh-token" });
  assert.deepEqual(decideRetry(404, { ...fresh, triedTokenRefresh: true }), { action: "reresolve-deployment" });
});

test("429 and 5xx back off with exponential delay", () => {
  assert.deepEqual(decideRetry(429, { ...fresh, attempt: 0 }), { action: "backoff", delayMs: 1000 });
  assert.deepEqual(decideRetry(500, { ...fresh, attempt: 1 }), { action: "backoff", delayMs: 2000 });
  assert.deepEqual(decideRetry(503, { ...fresh, attempt: 2 }), { action: "backoff", delayMs: 4000 });
});

test("backoff stops after the attempt budget", () => {
  assert.deepEqual(decideRetry(500, { ...fresh, attempt: MAX_BACKOFF_ATTEMPTS }), { action: "fail" });
});

test("client errors that are not 401/404 fail immediately", () => {
  for (const status of [400, 403, 413, 422]) {
    assert.deepEqual(decideRetry(status, fresh), { action: "fail" });
  }
});
