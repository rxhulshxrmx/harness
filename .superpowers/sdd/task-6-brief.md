### Task 6: `tools/index.ts` registry + `tools/readFile.ts` + `tools/listDir.ts`

**Files:**
- Create: `src/tools/index.ts`, `src/tools/index.test.ts`, `src/tools/readFile.ts`, `src/tools/readFile.test.ts`, `src/tools/listDir.ts`

**Interfaces:**
- Produces: `resolveWithinRoot(root: string, filePath: string): string` (pure, throws on escape); `getWorkspaceRoot(): string` (vscode-dependent); `ToolDefinition { schema: ToolSchema; execute(argsJson: string, ctx: ToolContext): Promise<string> }`; `ToolContext { workspaceRoot: string; signal: AbortSignal }`; `registerTool`, `getToolSchemas(): ToolSchema[]`, `runTool(name, argsJson, ctx): Promise<string>`; `truncate(text: string): string`.
- Consumes (from later tasks registering themselves): none yet — `readFile` and `listDir` self-register via `registerTool` at module load.

- [ ] **Step 1: Write the failing test for `resolveWithinRoot` and `truncate`**

```ts
// src/tools/index.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWithinRoot, truncate } from "./index";

test("resolveWithinRoot allows paths inside the root", () => {
  const resolved = resolveWithinRoot("/ws", "src/a.ts");
  assert.equal(resolved, "/ws/src/a.ts");
});

test("resolveWithinRoot rejects paths that escape the root", () => {
  assert.throws(() => resolveWithinRoot("/ws", "../outside.ts"), /escapes workspace root/);
  assert.throws(() => resolveWithinRoot("/ws", "/etc/passwd"), /escapes workspace root/);
});

test("truncate leaves short text untouched", () => {
  assert.equal(truncate("hello"), "hello");
});

test("truncate middle-elides text over 20000 chars", () => {
  const text = "H".repeat(9000) + "M".repeat(10000) + "T".repeat(9000);
  const out = truncate(text);
  assert.equal(out.length, 8000 + "\n…[truncated]…\n".length + 8000);
  assert.ok(out.startsWith("H".repeat(8000)));
  assert.ok(out.endsWith("T".repeat(8000)));
  assert.ok(out.includes("…[truncated]…"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './index'`

- [ ] **Step 3: Write `src/tools/index.ts`**

```ts
import * as path from "node:path";
import * as vscode from "vscode";
import type { ToolSchema } from "../aicore/types";

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute: (argsJson: string, ctx: ToolContext) => Promise<string>;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(name: string, def: ToolDefinition): void {
  registry.set(name, def);
}

export function getToolSchemas(): ToolSchema[] {
  return [...registry.values()].map((d) => d.schema);
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<string> {
  const def = registry.get(name);
  if (!def) return `Unknown tool: ${name}`;
  try {
    const result = await def.execute(argsJson, ctx);
    return truncate(result);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function resolveWithinRoot(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }
  return resolved;
}

export function getWorkspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error("No workspace folder open.");
  return root;
}

const MAX_LEN = 20_000;
const HALF = 8_000;

export function truncate(text: string): string {
  if (text.length <= MAX_LEN) return text;
  return text.slice(0, HALF) + "\n…[truncated]…\n" + text.slice(text.length - HALF);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/index.test.ts`
Expected: `# pass 4`

- [ ] **Step 5: Write the failing test for `readFile`**

```ts
// src/tools/readFile.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatFileContent } from "./readFile";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-"));
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: `Cannot find module './readFile'`

- [ ] **Step 7: Write `src/tools/readFile.ts`**

```ts
import * as fs from "node:fs";
import { registerTool, resolveWithinRoot, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

export function formatFileContent(absPath: string, offset: number, limit: number): string {
  const buf = fs.readFileSync(absPath);
  if (isBinary(buf)) return `[binary file, ${buf.length} bytes]`;

  const allLines = buf.toString("utf8").split("\n");
  const total = allLines.length;
  const start = Math.max(1, offset);
  const end = Math.min(total, start + limit - 1);
  const window = allLines.slice(start - 1, end);

  const width = String(end).length;
  const body = window.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join("\n");

  if (start === 1 && end === total) return body;
  return `${body}\n[showing lines ${start}-${end} of ${total}]`;
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns content with line numbers. Use offset/limit for large files.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "integer", description: "1-based first line, default 1" },
        limit: { type: "integer", description: "max lines, default 400" },
      },
      required: ["file_path"],
    },
  },
};

registerTool("read_file", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson);
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.file_path);
    return formatFileContent(abs, args.offset ?? 1, args.limit ?? 400);
  },
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/tools/readFile.test.ts`
Expected: `# pass 3`

- [ ] **Step 9: Write `src/tools/listDir.ts`** (manual verification only — depends on `vscode.workspace` for the root and reads the real filesystem tree; covered by the M1 manual check in Task 9)

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { registerTool, resolveWithinRoot, getWorkspaceRoot, type ToolContext } from "./index";
import type { ToolSchema } from "../aicore/types";

const HARD_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".forge"]);
const MAX_ENTRIES = 500;

function loadIgnorer(root: string) {
  const ig = ignore();
  const gitignorePath = path.join(root, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  return ig;
}

export function buildTree(root: string, startAbs: string, depth: number, ig: ReturnType<typeof ignore>): string {
  const lines: string[] = [];
  let count = 0;

  function walk(dirAbs: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth || count >= MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (count >= MAX_ENTRIES) return;
      if (HARD_EXCLUDES.has(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(root, abs);
      if (ig.ignores(rel)) continue;
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      count++;
      if (entry.isDirectory()) walk(abs, currentDepth + 1, prefix + "  ");
    }
  }

  walk(startAbs, 1, "");
  return lines.length ? lines.join("\n") : "(empty)";
}

const schema: ToolSchema = {
  type: "function",
  function: {
    name: "list_dir",
    description: "List files and directories as an indented tree, respecting .gitignore.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "default '.'" },
        depth: { type: "integer", description: "default 2, max 4" },
      },
    },
  },
};

registerTool("list_dir", {
  schema,
  async execute(argsJson: string, ctx: ToolContext) {
    const args = JSON.parse(argsJson || "{}");
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.path ?? ".");
    const depth = Math.min(4, args.depth ?? 2);
    const ig = loadIgnorer(ctx.workspaceRoot);
    return buildTree(ctx.workspaceRoot, abs, depth, ig);
  },
});

export { getWorkspaceRoot };
```

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/tools/index.ts src/tools/index.test.ts src/tools/readFile.ts src/tools/readFile.test.ts src/tools/listDir.ts
git commit -m "feat: tool registry, path guard, read_file, list_dir"
```

---

