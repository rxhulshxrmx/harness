import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redactSecrets.ts";

test("redacts OpenAI-style API keys", () => {
  const out = redactSecrets("export OPENAI_API_KEY=sk-abcdEFGH12345678901234");
  assert.doesNotMatch(out, /sk-abcdEFGH12345678901234/);
  assert.match(out, /\[REDACTED\]/);
});

test("redacts AWS access key IDs", () => {
  const out = redactSecrets("AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP");
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(out, /\[REDACTED\]/);
});

test("redacts bearer tokens", () => {
  const out = redactSecrets("Authorization: Bearer abc123.def456-ghi789_jkl");
  assert.doesNotMatch(out, /abc123\.def456-ghi789_jkl/);
  assert.match(out, /\[REDACTED\]/);
});

test("redacts generic key/token/secret/password assignments while preserving the key name", () => {
  const out = redactSecrets('api_key: "supersecretvalue123"');
  assert.match(out, /api_key: "\[REDACTED\]"/);

  const out2 = redactSecrets("password=hunter2ButLonger");
  assert.match(out2, /password=\[REDACTED\]/);
});

test("does not redact short values or normal-looking code", () => {
  const text = "const token = 'ok';\nfunction add(a, b) { return a + b; }";
  const out = redactSecrets(text);
  assert.doesNotMatch(out, /\[REDACTED\]/);
});

test("redacts multiple secrets in the same text", () => {
  const out = redactSecrets("key1=sk-abcdEFGH12345678901234\nkey2=AKIAABCDEFGHIJKLMNOP");
  assert.equal((out.match(/\[REDACTED\]/g) ?? []).length, 2);
});
