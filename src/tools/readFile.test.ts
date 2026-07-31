import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatFileContent } from "./readFile.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatFileContent numbers lines and reports the window", () => {
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "one\ntwo\nthree\n");
  const out = formatFileContent(file, 1, 400);
  assert.match(out, /^\s+1\tone$/m);
  assert.match(out, /^\s+3\tthree$/m);
});

test("formatFileContent respects offset/limit and reports truncation", () => {
  const file = path.join(dir, "b.txt");
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
  const out = formatFileContent(file, 2, 3);
  assert.match(out, /^\s+2\tline2$/m);
  assert.match(out, /^\s+4\tline4$/m);
  assert.doesNotMatch(out, /line5/);
  assert.match(out, /\[showing lines 2-4 of 10\]/);
});

test("formatFileContent reports binary files without reading them as text", () => {
  const file = path.join(dir, "bin.dat");
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 0, 255, 254]));
  const out = formatFileContent(file, 1, 400);
  assert.match(out, /^\[binary file, \d+ bytes\]$/);
});
