# Task 6 Report: tools/index.ts registry + tools/readFile.ts + tools/listDir.ts

## What was implemented

- `src/tools/index.ts` — tool registry (`registerTool`, `getToolSchemas`, `runTool`), the
  `resolveWithinRoot` path-escape guard, `getWorkspaceRoot`, and the `truncate` middle-elision
  helper.
- `src/tools/index.test.ts` — unit tests for `resolveWithinRoot` and `truncate`.
- `src/tools/readFile.ts` — `formatFileContent` plus the self-registering `read_file` tool.
- `src/tools/readFile.test.ts` — unit tests for `formatFileContent` (line numbering, offset/limit
  windowing, binary detection).
- `src/tools/listDir.ts` — `buildTree` plus the self-registering `list_dir` tool, using the
  `ignore` npm package for `.gitignore` handling.

All relative imports use explicit `.ts` extensions per project convention.

## TDD Evidence

### index.test.ts

RED (before `src/tools/index.ts` existed):
```
$ npx tsc --noEmit
src/tools/index.test.ts(3,45): error TS2307: Cannot find module './index.ts' or its corresponding type declarations.
```

GREEN (after writing `index.ts`):
```
$ npx tsc --noEmit
(no output — clean)

$ node --experimental-strip-types --test src/tools/index.test.ts
✔ resolveWithinRoot allows paths inside the root (0.613542ms)
✔ resolveWithinRoot rejects paths that escape the root (0.236417ms)
✔ truncate leaves short text untouched (0.058375ms)
✔ truncate middle-elides text over 20000 chars (0.110042ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```
Matches the brief's expected `# pass 4`.

### readFile.test.ts

RED (before `src/tools/readFile.ts` existed):
```
$ npx tsc --noEmit
src/tools/readFile.test.ts(6,35): error TS2307: Cannot find module './readFile.ts' or its corresponding type declarations.
```

GREEN (after writing `readFile.ts`, with one implementation fix — see below):
```
$ npx tsc --noEmit
(no output — clean)

$ node --experimental-strip-types --test src/tools/readFile.test.ts
✔ formatFileContent numbers lines and reports the window (0.622959ms)
✔ formatFileContent respects offset/limit and reports truncation (0.317167ms)
✔ formatFileContent reports binary files without reading them as text (0.271209ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```
Matches the brief's expected `# pass 3`.

Full suite (`npm test`, all 4 task areas so far): **15/15 pass**, `npx tsc --noEmit` clean.

## Deviations from the brief's literal code (both required to reach GREEN)

### 1. `getWorkspaceRoot` — lazy `require("vscode")` instead of a top-level `import`

The brief's `index.ts` has `import * as vscode from "vscode";` at the top of the file. There is
no `vscode` package in `node_modules` (by design — it's only supplied inside a live extension
host). Because `index.test.ts` imports `resolveWithinRoot`/`truncate` from the same module, a
static top-level `import` of `vscode` makes **the whole module fail to load** under plain
`node --test`, before any test body runs:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vscode' imported from .../src/tools/index.ts
```

I confirmed this is not a config problem on my end: it breaks `npm test` for the *entire* project
(all 4 prior test files started failing as a group, since node's `--test` glob loads every file
in one process). This is also consistent with the existing codebase precedent —
`src/aicore/client.ts` already imports `vscode` and, notably, has **no** test file, specifically
because such a file can't be loaded under plain `node --test`.

Fix: reference `vscode` lazily via a plain `require("vscode")` call *inside* the
`getWorkspaceRoot()` function body (typed via `declare function require(id: "vscode"): typeof
vscodeTypes;`, with `vscodeTypes` imported as `import type * as vscodeTypes from "vscode"` — a
type-only import, resolved against `@types/vscode` at typecheck time with zero runtime footprint).

Why this is safe and preserves behavior:
- **Under `node --test`**: the module's top-level code no longer references `vscode` at all, so it
  loads fine. The `require("vscode")` line only executes if `getWorkspaceRoot()` is actually
  called — which no test does (the brief's own test suite doesn't test `getWorkspaceRoot` either).
- **Inside the real extension**: `esbuild.mjs` already bundles to CJS with `external: ["vscode"]`.
  I verified with a minimal esbuild repro that a `require("vscode")` call written directly in ESM
  source (no `createRequire`) is passed through **verbatim** in the CJS bundle output — esbuild's
  external-marking applies to any syntactically-recognized `require(literal)` call, not just
  top-level ones. So the bundled extension still gets a plain `require("vscode")`, served by the
  extension host exactly as before. (I also tried a `createRequire(import.meta.url)` variant
  first; that turned out to be broken in the bundled output because esbuild empties
  `import.meta.url` when targeting CJS, which throws in `createRequire` at runtime — I caught this
  with a build+run repro before adopting it, and reverted to the simpler `require()` approach.)
- The function's public signature, return type, and error behavior (`getWorkspaceRoot(): string`,
  throws `"No workspace folder open."` when no folder is open) are unchanged from the brief.

`resolveWithinRoot` and `truncate` themselves are untouched — byte-for-byte the brief's code.

### 2. `formatFileContent` — line-number padding width bug

The brief's reference implementation computes `const width = String(end).length;` (padding based
on the last line number *shown in the window*). Run against the brief's own test file verbatim,
this fails two of three assertions:

```
✖ formatFileContent numbers lines and reports the window
  AssertionError: /^\s+1\tone$/m did not match '1\tone\n2\ttwo\n3\tthree\n4\t'
✖ formatFileContent respects offset/limit and reports truncation
  AssertionError: /^\s+2\tline2$/m did not match '2\tline2\n3\tline3\n4\tline4\n[showing lines 2-4 of 10]'
```

Root cause: when the largest line number shown is single-digit, `String(end).length` is `1`, so
`padStart(1)` adds zero padding — but the tests assert a leading whitespace character (`\s+`)
before every line number, including single-digit ones (e.g. in the second test, the file has 10
lines total, so the intent is clearly to reserve 2-character-wide alignment even though only
single-digit numbers 2–4 are in the displayed window).

Fix: `const width = Math.max(2, String(total).length);` — base the width on the file's total line
count (consistent alignment across different offset windows into the same file, not just the
window itself) with a 2-character floor (so small/short files still get a leading space for
single-digit numbers, matching the test's literal expectation). Verified this satisfies all three
test assertions exactly (traced through both test cases by hand before running, then confirmed via
the passing test run above).

## How listDir.ts was verified

No dedicated unit test was written, per the brief and task instructions — `buildTree`'s only
consumer path (`list_dir`'s `execute`) needs `ctx.workspaceRoot` from a real `ToolContext` and
walks a real filesystem tree with real `.gitignore` semantics; the brief explicitly defers
meaningful verification to the M1 manual check in Task 9. Verification here was limited to:
- `npx tsc --noEmit` — clean, including the `ignore` package's shipped types (`import ignore from
  "ignore"` resolved without issue; no `@types/ignore` needed).
- Manual trace-through of `buildTree`'s recursion, hard-exclude set, `.gitignore` matching via
  `ig.ignores(rel)`, `MAX_ENTRIES` cap, and the `list_dir` schema/`execute` wiring against the
  brief's code — matches exactly, no deviations.

## Files changed

- `/Users/rahulsharma/Developer/Forge/src/tools/index.ts` (new)
- `/Users/rahulsharma/Developer/Forge/src/tools/index.test.ts` (new)
- `/Users/rahulsharma/Developer/Forge/src/tools/readFile.ts` (new)
- `/Users/rahulsharma/Developer/Forge/src/tools/readFile.test.ts` (new)
- `/Users/rahulsharma/Developer/Forge/src/tools/listDir.ts` (new)

Commit: `de82475` — "feat: tool registry, path guard, read_file, list_dir"

## Self-review findings

**`resolveWithinRoot` (security-critical) — matches the brief exactly, unmodified:**

```ts
export function resolveWithinRoot(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }
  return resolved;
}
```

Traced by hand against both required brief test cases plus extra edge cases:

- `resolveWithinRoot("/ws", "src/a.ts")` → `resolved = "/ws/src/a.ts"`, `rel = "src/a.ts"` → no
  `..`, not absolute → returns `"/ws/src/a.ts"`. Matches brief.
- `resolveWithinRoot("/ws", "../outside.ts")` → `resolved = "/outside.ts"`,
  `rel = "../outside.ts"` → starts with `..` → throws `Path escapes workspace root: ../outside.ts`
  (matches `/escapes workspace root/`). Matches brief.
- `resolveWithinRoot("/ws", "/etc/passwd")` → `path.resolve` treats the absolute second argument
  as authoritative, so `resolved = "/etc/passwd"`; `rel = path.relative("/ws", "/etc/passwd")
  = "../etc/passwd"` → starts with `..` → throws. Matches brief.
- Prefix-confusion check (not in the brief's tests, but worth confirming since it's the classic
  bypass for this kind of guard): `resolveWithinRoot("/ws", "/ws-evil/x")` →
  `resolved = "/ws-evil/x"` (absolute arg wins), `rel = path.relative("/ws", "/ws-evil/x")
  = "../ws-evil/x"` → starts with `..` → correctly **rejected**. This confirms the implementation
  uses `path.relative` rather than a naive `resolved.startsWith(root)` string check, so a sibling
  directory that merely shares `root` as a string prefix (`/ws-evil` vs `/ws`) is not incorrectly
  allowed through.
- Root-itself case: `resolveWithinRoot("/ws", ".")` → `resolved = "/ws"`, `rel = ""` → neither
  check trips → allowed, as expected (the workspace root itself is always in-bounds).

No weakening of the check was made or considered necessary. All 4 tests from `index.test.ts` pass.

## Concerns

- I deviated from the brief's literal code in two places (documented above): `getWorkspaceRoot`'s
  `vscode` import strategy, and `formatFileContent`'s padding-width formula. Both changes were
  required to make the brief's own test files pass (`# pass 4` / `# pass 3` as the brief itself
  specifies), and I did not touch any test file content or the `resolveWithinRoot`/`truncate`
  logic to get there. Flagging clearly in case the plan's later tasks (or the human reviewer)
  expect the literal brief text verbatim rather than a working version of it.
- `listDir.ts` is unverified beyond typecheck + manual trace, as intended by the brief — first
  real exercise is the Task 9 manual M1 check.
- Windows-style path escaping was not considered (out of scope per task instructions, and the
  brief's tests don't cover it); flagging per the "over your head" guidance rather than guessing.
