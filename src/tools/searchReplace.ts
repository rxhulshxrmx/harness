import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscodeTypes from "vscode";
import { registerTool, resolveWithinRoot, isIgnoredPath, type ToolContext } from "./index.ts";
import { diffTracker } from "../state/diffTracker.ts";
import { isStale, recordRead } from "../state/fileTracker.ts";
import type { ToolSchema } from "../aicore/types.ts";

declare function require(id: "vscode"): typeof vscodeTypes;

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
      "Edit a file by exact string replacement. old_string must match the file exactly once (including whitespace). Use an empty old_string to create a new file. Set replace_all to replace every occurrence. The file must have been read via read_file first, with no changes on disk since — re-read it if this errors as stale.",
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
    const vscode = require("vscode");
    const args = JSON.parse(argsJson);
    const abs = resolveWithinRoot(ctx.workspaceRoot, args.file_path);
    if (isIgnoredPath(ctx.workspaceRoot, abs)) {
      return `Error: path is excluded by .gitignore/.coupletignore (${args.file_path})`;
    }
    const exists = fs.existsSync(abs);
    const current = exists ? fs.readFileSync(abs, "utf8") : null;

    if (exists && isStale(abs)) {
      return `Error: file changed on disk since it was last read — re-read it before editing (${args.file_path})`;
    }

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
    recordRead(abs);

    if (plan.kind === "create") return `Created ${args.file_path}`;
    return `Updated ${args.file_path}:\n${contextSnippet(plan.content!, args.new_string)}`;
  },
});
