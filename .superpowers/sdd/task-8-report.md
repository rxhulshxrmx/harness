# Task 8 Report: tools/searchReplace.ts

## What I implemented

- `src/tools/searchReplace.test.ts` — 5 unit tests for the pure `planReplacement` function, exactly as specified in the brief (create-on-empty-old-string, zero-match error, multi-match-without-replace_all error, single-match replace, replace_all).
- `src/tools/searchReplace.ts` — matches the brief's logic (`planReplacement`, `countOccurrences`, `contextSnippet`, the `search_replace` tool schema, and the `execute` function's control flow) exactly, **except** for the vscode import strategy: instead of a top-level `import * as vscode from "vscode";`, I used the established lazy-require pattern from `src/tools/index.ts` and `src/aicore/client.ts`:
  - `import type * as vscodeTypes from "vscode";` (type-only, erased at compile time)
  - `declare function require(id: "vscode"): typeof vscodeTypes;` (ambient shim)
  - `const vscode = require("vscode");` called once, at the top of the `execute` function body (the only place in the file that touches vscode APIs — `Uri`, `WorkspaceEdit`, `Range`, `workspace.openTextDocument`, `workspace.applyEdit`).
  - `planReplacement` itself remains untouched/pure — no vscode dependency at all.
- `src/state/diffTracker.ts` — temporary stub per the brief, to be replaced wholesale in a later task (the task description said Task 13; the brief text said Task 14 — deferred to whichever task actually does it):
  ```ts
  export const diffTracker = {
    snapshot(_filePath: string, _contentBefore: string | null) {},
  };
  ```

All relative imports use explicit `.ts` extensions per project convention.

## TDD Evidence

### RED

Command: `node --experimental-strip-types --test src/tools/searchReplace.test.ts` (run before `searchReplace.ts` existed)

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/rahulsharma/Developer/Forge/src/tools/searchReplace.ts' imported from /Users/rahulsharma/Developer/Forge/src/tools/searchReplace.test.ts
...
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

### GREEN

Command: `node --experimental-strip-types --test src/tools/searchReplace.test.ts` (after writing `searchReplace.ts` and the `diffTracker.ts` stub)

```
✔ empty old_string on non-existent file creates it (0.392917ms)
✔ zero matches is an error (0.103125ms)
✔ multiple matches without replace_all is an error (0.481042ms)
✔ exactly one match replaces (0.06425ms)
✔ replace_all replaces every occurrence (0.055875ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

### Typecheck

Command: `npx tsc --noEmit` → no output, no errors.

## Full suite result

Command: `npm test` (runs `node --experimental-strip-types --test src/**/*.test.ts`)

```
ℹ tests 22
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

22 = 17 (pre-existing) + 5 (new). All prior tests (aicore token/auth/sse, tools index/grep/readFile) still pass.

## Files changed

- `/Users/rahulsharma/Developer/Forge/src/tools/searchReplace.ts` (new)
- `/Users/rahulsharma/Developer/Forge/src/tools/searchReplace.test.ts` (new)
- `/Users/rahulsharma/Developer/Forge/src/state/diffTracker.ts` (new, temporary stub)

Commit: `702d77f` — "feat: search_replace tool with exact-match semantics (diffTracker stub)"

(Note: an untracked `docs/` directory exists in the repo but is unrelated to this task and was left alone/not staged.)

## Self-review findings

Checked `planReplacement` against all 5 brief test cases:
1. `planReplacement(null, "", "hello", false)` → `oldString === "" && currentContent === null` branch → `{kind: "create", content: "hello"}`. Matches test 1.
2. `planReplacement("const a = 1;", "const b", "const c", false)` → currentContent non-null, `countOccurrences` finds 0 → error matching `/No match for old_string/`. Matches test 2.
3. `planReplacement("x\nx\nx", "x", "y", false)` → 3 occurrences, `replaceAll` false → error `old_string matched 3 times...` matches `/matched 3 times/`. Matches test 3.
4. `planReplacement("const a = 1;\nconst b = 2;", "const a = 1;", "const a = 2;", false)` → 1 occurrence → `.replace()` → `"const a = 2;\nconst b = 2;"`. Matches test 4.
5. `planReplacement("x\nx\nx", "x", "y", true)` → 3 occurrences, `replaceAll` true → `.split("x").join("y")` → `"y\ny\ny"`. Matches test 5.

Confirmed no stray top-level `import ... from "vscode"` anywhere in `searchReplace.ts` (verified via grep — only the type-only import, the ambient `declare function require`, and the single lazy call inside `execute` reference "vscode"). The lazy-require call is assigned once to a local `vscode` const at the top of `execute` and reused for all four vscode API touch points in that function, matching the pattern in `index.ts`'s `getWorkspaceRoot()` and `client.ts`'s `readConfig()`.

No deviations from the brief's logic found. No issues.

## Concerns

None. `execute()` itself was not run against a live VS Code extension host (not possible in this environment) — per the brief, that path is "manually verified" outside the automated test suite, consistent with how Tasks 6/7's vscode-touching `execute` functions were handled.
