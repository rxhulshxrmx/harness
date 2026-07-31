import * as fs from "node:fs";
import * as path from "node:path";
import type { Session } from "./session.ts";
import type { Message } from "../aicore/types.ts";

function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".harness", "sessions");
}

export function newSessionFilePath(workspaceRoot: string, session: Session): string {
  const dir = sessionsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.createdAt.replace(/[:.]/g, "-")}-${session.id}.jsonl`);
  fs.writeFileSync(filePath, JSON.stringify({ type: "meta", title: session.title, createdAt: session.createdAt, model: session.model }) + "\n");
  return filePath;
}

export function appendToStore(session: Session, message: Message): void {
  if (!session.filePath) return;
  fs.appendFileSync(session.filePath, JSON.stringify(message) + "\n");
}

export function listSessions(workspaceRoot: string): { id: string; title: string; filePath: string }[] {
  const dir = sessionsDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files
    .map((f) => {
      const filePath = path.join(dir, f);
      const firstLine = fs.readFileSync(filePath, "utf8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      const id = f.split("-").pop()!.replace(".jsonl", "");
      return { id, title: meta.title || "(untitled)", filePath };
    })
    .sort((a, b) => b.filePath.localeCompare(a.filePath));
}

export function updateSessionTitle(filePath: string, title: string): void {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const meta = JSON.parse(lines[0]);
  meta.title = title;
  lines[0] = JSON.stringify(meta);
  fs.writeFileSync(filePath, lines.join("\n"));
}

export function loadSession(filePath: string): Session {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const meta = JSON.parse(lines[0]);
  const messages: Message[] = [];
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line);
    if (parsed.type === "compaction") continue;
    messages.push(parsed);
  }
  const id = path.basename(filePath).split("-").pop()!.replace(".jsonl", "");
  return { id, title: meta.title, createdAt: meta.createdAt, model: meta.model, messages, filePath };
}
