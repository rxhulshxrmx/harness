### Task 8: `tools/searchReplace.ts`

**Files:**
- Create: `src/tools/searchReplace.ts`, `src/tools/searchReplace.test.ts`

**Interfaces:**
- Consumes: `resolveWithinRoot`, `registerTool`, `truncate` from Task 6.
- Produces: pure `planReplacement(content: string | null, oldString: string, newString: string, replaceAll: boolean): { kind: "create" | "replace" | "error"; content?: string; error?: string; matchStartLine?: number }` — the string-matching logic, unit tested without touching the filesystem or `vscode`. The tool's `execute` wraps this with file I/O and `vscode.WorkspaceEdit` (manually verified).

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/searchReplace.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planReplacement } from "./searchReplace";

test("empty old_string on non-existent file creates it", () => {
  const plan = planReplacement(null, "", "hello", false);
  assert.equal(plan.kind, "create");
  assert.equal(plan.content, "hello");
});

test("zero matches is an error", () => {
  const plan = planReplacement("const a = 1;", "const b", "const c", false);
  assert.equal(plan.kind, "error");
  assert.match(plan.error!, /No match for old_string/);
});

test("multiple matches without replace_all is an error", () => {
  const plan = planReplacement("x\nx\nx", "x", "y", false);
  assert.equal(plan.kind, "error");
  assert.match(plan.error!, /matched 3 times/);
});

test("exactly one match replaces", () => {
  const plan = planReplacement("const a = 1;\nconst b = 2;", "const a = 1;", "const a = 2;", false);
  assert.equal(plan.kind, "replace");
  assert.equal(plan.content, "const a = 2;\nconst b = 2;");
});

test("replace_all replaces every occurrence", () => {
  const plan = planReplacement("x\nx\nx", "x", "y", true);
  assert.equal(plan.kind, "replace");
  assert.equal(plan.content, "y\ny\ny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './searchReplace'`

- [ ] **Step 3: Write `src/tools/searchReplace.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerTool, resolveWithinRoot, type ToolContext } from "./index";
import { diffTracker } from "../state/diffTracker";
import type { ToolSchema } from "../aicore/types";

export interface ReplacementPlan {
  kind: "create" | "replace" | "error";
  content?: string;
  error?: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

export function planReplacement(
  currentContent: string | null,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplacementPlan {
  if (oldString === "" && currentContent === null) {
    return { kind: "create", content: newString };
  }
  if (currentContent === null) {
    return { kind: "error", error: "File does not exist and old_string is not empty." };
  }

  const occurrences = countOccurrences(currentContent, oldString);
  if (occurrences === 0) {
    return { kind: "error", error: "No match for old_string in file. Read the file again — it may have changed." };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      kind: "error",
      error: `old_string matched ${occurrences} times. Add surrounding lines to make it unique, or set replace_all.`,
    };
  }

  const content = replaceAll
    ? currentContent.split(oldString).join(newString)
    : currentContent.replace(oldString, newString);
  return { kind: "replace", content };
}

function contextSnippet(content: string, newString: string): string {
  const lines = content.split("\n");
  const newLines = newString.split("\n");
  const idx = content.indexOf(newString);
  const before = content.slice(0, idx).split("\n").length - 1;
  const start = Math.max(0, before - 3);
  const end = Math.min(lines.length, before + newLines.length + 3);
  const width = String(end).length;
  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)
    .join("\n");
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "search_replace",
    description:
      "Edit a file by exact string replacement. old_string must match the file exactly once (including whitespace). Use an empty old_string to create a new file. Set replace_all to replace every occurrence.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
};

registerTool("search_replace", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.file_path);
    const exists = fs.existsSync(abs);
    const current = exists ? fs.readFileSync(abs, "utf8") : null;

    const plan = planReplacement(current, args.old_string, args.new_string, !!args.replace_all);
    if (plan.kind === "error") return `Error: ${plan.error} (${args.file_path})`;

    diffTracker.snapshot(args.file_path, current);

    if (plan.kind === "create") {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
    }

    const uri = vscode.Uri.file(abs);
    const edit = new vscode.WorkspaceEdit();
    if (plan.kind === "create") {
      edit.createFile(uri, { overwrite: true, contents: Buffer.from(plan.content!, "utf8") });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, fullRange, plan.content!);
    }
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();

    if (plan.kind === "create") return `Created ${args.file_path}`;
    return `Updated ${args.file_path}:\n${contextSnippet(plan.content!, args.new_string)}`;
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/searchReplace.test.ts`
Expected: `# pass 5`

Note: `searchReplace.ts` imports `../state/diffTracker`, which does not exist until Task 14. For this task, create a temporary stub so `tsc` passes, to be replaced wholesale in Task 14:

```ts
// src/state/diffTracker.ts (temporary stub — replaced in Task 14)
export const diffTracker = {
  snapshot(_filePath: string, _contentBefore: string | null) {},
};
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/searchReplace.ts src/tools/searchReplace.test.ts src/state/diffTracker.ts
git commit -m "feat: search_replace tool with exact-match semantics (diffTracker stub)"
```

---

