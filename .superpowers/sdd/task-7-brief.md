### Task 7: `tools/grep.ts`

**Files:**
- Create: `src/tools/grep.ts`, `src/tools/grep.test.ts`

**Interfaces:**
- Consumes: `resolveWithinRoot`, `registerTool` from Task 6.
- Produces: pure `searchInText(content: string, pattern: RegExp, filePath: string, maxResults: number): string[]` used by the tool's `execute` when walking the filesystem.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/grep.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchInText } from "./grep";

test("searchInText returns path:line:text for each match", () => {
  const content = "foo\nbar getToken\nbaz\ngetToken again";
  const hits = searchInText(content, /getToken/, "src/a.ts", 100);
  assert.deepEqual(hits, ["src/a.ts:2: bar getToken", "src/a.ts:4: getToken again"]);
});

test("searchInText stops at maxResults", () => {
  const content = "x\nx\nx\nx";
  const hits = searchInText(content, /x/, "f.ts", 2);
  assert.equal(hits.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './grep'`

- [ ] **Step 3: Write `src/tools/grep.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { registerTool, resolveWithinRoot, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

const HARD_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".forge"]);
const MAX_FILE_BYTES = 1_000_000;

export function searchInText(content: string, pattern: RegExp, filePath: string, maxResults: number): string[] {
  const hits: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
    if (pattern.test(lines[i])) {
      hits.push(`${filePath}:${i + 1}: ${lines[i]}`);
    }
    pattern.lastIndex = 0;
  }
  return hits;
}

function matchesGlob(rel: string, glob?: string): boolean {
  if (!glob) return true;
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "
        .replace(/\*/g, "[^/]*")
        .replace(/
      "$",
  );
  return re.test(rel);
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents by regex across the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string", description: "e.g. '**/*.ts'" },
        max_results: { type: "integer", description: "default 100" },
      },
      required: ["pattern"],
    },
  },
};

registerTool("grep", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const maxResults = args.max_results ?? 100;
    const re = new RegExp(args.pattern);
    const ig = ignore();
    const gitignorePath = path.join(ctx.workspaceRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) ig.add(fs.readFileSync(gitignorePath, "utf8"));

    const results: string[] = [];

    function walk(dirAbs: string) {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (HARD_EXCLUDES.has(entry.name)) continue;
        const abs = path.join(dirAbs, entry.name);
        const rel = path.relative(ctx.workspaceRoot, abs);
        if (ig.ignores(rel)) continue;
        if (entry.isDirectory()) {
          walk(abs);
        } else if (matchesGlob(rel, args.glob)) {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = fs.readFileSync(abs, "utf8").toString();
          results.push(...searchInText(content, re, rel, maxResults - results.length));
        }
      }
    }

    walk(resolveWithinRoot(ctx.workspaceRoot, "."));
    return results.length ? results.join("\n") : "No matches.";
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/grep.test.ts`
Expected: `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add src/tools/grep.ts src/tools/grep.test.ts
git commit -m "feat: grep tool with gitignore-aware workspace walk"
```

---

