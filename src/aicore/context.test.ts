import { test } from "node:test";
import assert from "node:assert/strict";
import { setExtensionContext, getSecrets } from "./context.ts";

test("getSecrets throws before setExtensionContext has been called", () => {
  assert.throws(() => getSecrets(), /not initialized/);
});

test("getSecrets returns the stored context's secrets after setExtensionContext", () => {
  const fakeSecrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  setExtensionContext({ secrets: fakeSecrets } as any);
  assert.equal(getSecrets(), fakeSecrets);
});
