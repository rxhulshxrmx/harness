import * as fs from "node:fs";
import * as path from "node:path";

const CAP = 8_000;

export function loadAgentsMd(workspaceRoot: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(workspaceRoot, name);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8").slice(0, CAP);
      return `Project instructions (AGENTS.md):\n${content}`;
    }
  }
  return "";
}
