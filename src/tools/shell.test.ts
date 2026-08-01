import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShell, findOnWindowsPath, shellGuidance } from "./shell.ts";

const none = () => false;
const all = () => true;

test("posix platforms use the platform default shell and support && ", () => {
  const info = resolveShell("darwin", { SHELL: "/bin/zsh" }, none);
  assert.equal(info.spawnShell, true);
  assert.equal(info.label, "/bin/zsh");
  assert.equal(info.family, "posix");
  assert.equal(info.supportsAndOr, true);
});

test("posix falls back to bash when SHELL is unset", () => {
  assert.equal(resolveShell("linux", {}, none).label, "/bin/bash");
});

// The whole point of the detection: 5.1 cannot parse "&&", 7+ can. Reporting
// this wrongly is what makes the model emit a command that can only ever fail.
test("windows prefers pwsh 7+ when it is on PATH", () => {
  const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7" };
  const exists = (p: string) => p === "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const info = resolveShell("win32", env, exists);
  assert.equal(info.spawnShell, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(info.supportsAndOr, true);
  assert.equal(info.family, "powershell");
});

test("windows falls back to powershell 5.1 and reports no && support", () => {
  const info = resolveShell("win32", { PATH: "C:\\Windows\\System32" }, none);
  assert.equal(info.spawnShell, "powershell.exe");
  assert.equal(info.supportsAndOr, false);
  assert.equal(info.family, "powershell");
});

test("PATH lookup handles the Path spelling, quotes, and trailing separators", () => {
  const exists = (p: string) => p === "C:\\tools\\pwsh.exe";
  assert.equal(findOnWindowsPath("pwsh.exe", { Path: '"C:\\tools\\";C:\\other' }, exists), "C:\\tools\\pwsh.exe");
  assert.equal(findOnWindowsPath("pwsh.exe", { PATH: "" }, all), null);
  assert.equal(findOnWindowsPath("pwsh.exe", {}, all), null);
});

test("guidance is empty for posix, so mac and linux pay no tokens for it", () => {
  assert.equal(shellGuidance(resolveShell("darwin", { SHELL: "/bin/zsh" }, none)), "");
});

test("guidance tells 5.1 not to use && but allows it on 7+", () => {
  const five = shellGuidance(resolveShell("win32", { PATH: "" }, none));
  assert.match(five, /NO "&&"/);
  assert.match(five, /\$LASTEXITCODE/);

  const seven = shellGuidance(resolveShell("win32", { PATH: "C:\\ps7" }, all));
  assert.doesNotMatch(seven, /NO "&&"/);
  assert.match(seven, /Chain steps/);
});
