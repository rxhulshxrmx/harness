import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, HttpError } from "./errors.ts";

test("classifies an AbortError (name) as aborted, not shown as an error", () => {
  const err = new DOMException("This operation was aborted", "AbortError");
  const result = classifyError(err);
  assert.equal(result.category, "aborted");
  assert.equal(result.retryable, false);
});

test("classifies the internal 'Aborted' message as aborted", () => {
  const result = classifyError(new Error("Aborted"));
  assert.equal(result.category, "aborted");
});

test("classifies HttpError 401 as auth, not retryable", () => {
  const result = classifyError(new HttpError(401, "unauthorized"));
  assert.equal(result.category, "auth");
  assert.equal(result.retryable, false);
});

test("classifies HttpError 429 as rate_limit, retryable", () => {
  const result = classifyError(new HttpError(429, "too many requests"));
  assert.equal(result.category, "rate_limit");
  assert.equal(result.retryable, true);
});

test("classifies a context-length error body as context_too_long even on a 400", () => {
  const result = classifyError(new HttpError(400, '{"error":{"message":"maximum context length is 128000 tokens"}}'));
  assert.equal(result.category, "context_too_long");
  assert.equal(result.retryable, false);
});

test("classifies HttpError 5xx as server, retryable", () => {
  assert.equal(classifyError(new HttpError(500, "boom")).category, "server");
  assert.equal(classifyError(new HttpError(503, "boom")).category, "server");
  assert.equal(classifyError(new HttpError(500, "boom")).retryable, true);
});

test("classifies an unrecognized HttpError status as unknown", () => {
  const result = classifyError(new HttpError(418, "teapot"));
  assert.equal(result.category, "unknown");
});

test("classifies a network-ish error message as network, retryable", () => {
  assert.equal(classifyError(new Error("fetch failed")).category, "network");
  assert.equal(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443")).category, "network");
  assert.equal(classifyError(new Error("network timeout")).retryable, true);
});

test("classifies a plain unrelated error as unknown, preserving its message", () => {
  const result = classifyError(new Error("something bizarre happened"));
  assert.equal(result.category, "unknown");
  assert.equal(result.message, "something bizarre happened");
});

test("classifies a non-Error thrown value as unknown", () => {
  const result = classifyError("just a string");
  assert.equal(result.category, "unknown");
  assert.equal(result.message, "just a string");
});
