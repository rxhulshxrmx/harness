import * as crypto from "node:crypto";
import type { Message } from "../aicore/types.ts";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  model: string;
  messages: Message[];
  filePath?: string;
}

export function createSession(firstUserText: string, model: string): Session {
  const id = crypto.randomBytes(3).toString("hex");
  return {
    id,
    title: firstUserText.slice(0, 60),
    createdAt: new Date().toISOString(),
    model,
    messages: [],
  };
}
