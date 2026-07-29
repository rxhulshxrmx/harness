# Task 6b: Lazy-require vscode in client.ts

## Summary
Applied the lazy-require pattern to `src/aicore/client.ts` to prevent module-not-found errors when test files transitively load this module. The vscode module is now required only inside the `readConfig()` function where it's actually used, matching the pattern established in `src/tools/index.ts`.

## Changes

### Before
```typescript
import * as vscode from "vscode";
import * as fs from "node:fs";
// ...

function readConfig() {
  const cfg = vscode.workspace.getConfiguration("forge");
  // ...
}
```

### After
```typescript
import * as fs from "node:fs";
import type * as vscodeTypes from "vscode";
// ...

declare function require(id: "vscode"): typeof vscodeTypes;

function readConfig() {
  const vscode = require("vscode");
  const cfg = vscode.workspace.getConfiguration("forge");
  // ...
}
```

## Verification

### 1. TypeScript Compilation
```bash
$ npx tsc --noEmit
✓ Passed (no errors)
```

### 2. Test Suite
```bash
$ npm test
✔ tests 15
✔ pass 15
✔ fail 0
✓ All tests passing (same as before)
```

### 3. Build
```bash
$ npm run build
✓ Succeeded
$ grep -c 'require("vscode")' dist/extension.js
2
```
Confirmed: bundled output contains 2 lazy require calls (one from tools/index.ts, one from aicore/client.ts).

## Commit
- **SHA**: 759a415
- **Message**: "refactor: lazily require vscode in client.ts to keep test imports loadable"

## Notes
- No behavior changes; this is purely a module-loading restructure
- The `chat()` function's retry/backoff/streaming logic remains byte-identical
- Pattern matches established practice in `src/tools/index.ts`
- Ready for downstream task (compaction.ts) that will import from this module
