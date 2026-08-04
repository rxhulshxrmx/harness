import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAuthUrl, normalizeApiUrl } from "./urls.ts";

test("auth URL drops an already-appended /oauth/token", () => {
  assert.equal(
    normalizeAuthUrl("https://sub.authentication.eu10.hana.ondemand.com/oauth/token"),
    "https://sub.authentication.eu10.hana.ondemand.com",
  );
  assert.equal(
    normalizeAuthUrl("https://sub.authentication.eu10.hana.ondemand.com/oauth/token?grant_type=client_credentials"),
    "https://sub.authentication.eu10.hana.ondemand.com",
  );
});

test("auth URL survives trailing slashes, quotes and stray whitespace", () => {
  const want = "https://sub.authentication.eu10.hana.ondemand.com";
  assert.equal(normalizeAuthUrl("  https://sub.authentication.eu10.hana.ondemand.com//  "), want);
  assert.equal(normalizeAuthUrl('"https://sub.authentication.eu10.hana.ondemand.com"'), want);
});

test("a URL pasted without a scheme is assumed to be https", () => {
  assert.equal(normalizeAuthUrl("sub.authentication.eu10.hana.ondemand.com"), "https://sub.authentication.eu10.hana.ondemand.com");
  assert.equal(normalizeApiUrl("api.ai.eu10.hana.ondemand.com"), "https://api.ai.eu10.hana.ondemand.com");
});

test("API URL drops a trailing /v2 and its usual sub-paths", () => {
  const want = "https://api.ai.eu10.hana.ondemand.com";
  assert.equal(normalizeApiUrl("https://api.ai.eu10.hana.ondemand.com/v2"), want);
  assert.equal(normalizeApiUrl("https://api.ai.eu10.hana.ondemand.com/v2/"), want);
  assert.equal(normalizeApiUrl("https://api.ai.eu10.hana.ondemand.com/v2/lm"), want);
  assert.equal(normalizeApiUrl("https://api.ai.eu10.hana.ondemand.com/v2/inference/deployments"), want);
});

test("a host that legitimately contains v2 is left alone", () => {
  assert.equal(normalizeApiUrl("https://api.v2.example.com"), "https://api.v2.example.com");
  assert.equal(normalizeApiUrl("https://api.example.com/v2x"), "https://api.example.com/v2x");
});

test("empty and whitespace-only input normalises to empty", () => {
  for (const raw of ["", "   ", '""', "/"]) {
    assert.equal(normalizeAuthUrl(raw), "");
    assert.equal(normalizeApiUrl(raw), "");
  }
});
