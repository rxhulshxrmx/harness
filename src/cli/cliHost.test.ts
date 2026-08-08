import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliHost } from "./cliHost.ts";
import { CLIENT_SECRET_KEY } from "../aicore/config.ts";

test("getConfig falls back to the default when the env var is unset", () => {
  const host = new CliHost("/ws", {});
  assert.equal(host.getConfig("model", ""), "");
  assert.equal(host.getConfig("contextBudget", 100_000), 100_000);
});

test("getConfig reads from the mapped COUPLET_* env var, coercing to the default's type", () => {
  const host = new CliHost("/ws", { COUPLET_MODEL: "gpt-4o", COUPLET_CONTEXT_BUDGET: "50000" });
  assert.equal(host.getConfig("model", ""), "gpt-4o");
  assert.equal(host.getConfig("contextBudget", 100_000), 50_000);
});

test("getSecret only resolves the client secret key, from COUPLET_CLIENT_SECRET", async () => {
  const host = new CliHost("/ws", { COUPLET_CLIENT_SECRET: "s3cr3t" });
  assert.equal(await host.getSecret(CLIENT_SECRET_KEY), "s3cr3t");
  assert.equal(await host.getSecret("something.else"), undefined);
});

test("getAlwaysAllowed is always empty — headless mode has no standing approvals", () => {
  const host = new CliHost("/ws", {});
  assert.deepEqual(host.getAlwaysAllowed(), []);
});

test("writeFile creates parent directories and writes the file when create is true", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "couplet-clihost-"));
  try {
    const host = new CliHost(dir, {});
    const target = path.join(dir, "nested", "file.txt");
    await host.writeFile(target, "hello", { create: true });
    assert.equal(fs.readFileSync(target, "utf8"), "hello");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile overwrites an existing file when create is false", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "couplet-clihost-"));
  try {
    const target = path.join(dir, "file.txt");
    fs.writeFileSync(target, "old");
    const host = new CliHost(dir, {});
    await host.writeFile(target, "new", { create: false });
    assert.equal(fs.readFileSync(target, "utf8"), "new");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
