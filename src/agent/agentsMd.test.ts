import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentsMd } from "./agentsMd.ts";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agentsmd-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("returns empty string when neither file exists", () => {
  assert.equal(loadAgentsMd(dir), "");
});

test("reads AGENTS.md and wraps it under the heading", () => {
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Use 2-space indent.");
  const out = loadAgentsMd(dir);
  assert.match(out, /^Project instructions \(AGENTS\.md\):\n/);
  assert.match(out, /Use 2-space indent\./);
});

test("falls back to CLAUDE.md when AGENTS.md is absent", () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agentsmd2-"));
  fs.writeFileSync(path.join(dir2, "CLAUDE.md"), "Prefer functional style.");
  const out = loadAgentsMd(dir2);
  assert.match(out, /Prefer functional style\./);
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("caps content at 8000 characters", () => {
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "x".repeat(9000));
  const out = loadAgentsMd(dir);
  const body = out.replace("Project instructions (AGENTS.md):\n", "");
  assert.equal(body.length, 8000);
});
