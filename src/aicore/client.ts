import * as fs from "node:fs";
import type * as vscodeTypes from "vscode";
import { getToken, invalidateToken } from "./auth.ts";
import { splitSSEBuffer, mergeToolCallDelta, extractDataLines } from "./sse.ts";
import type { Message, AssistantMessage, ToolSchema, ToolCall, ServiceKey } from "./types.ts";

declare function require(id: "vscode"): typeof vscodeTypes;

function loadServiceKey(keyPath: string): ServiceKey {
  if (!keyPath) throw new Error("forge.serviceKeyPath is not set.");
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

function readConfig() {
  const vscode = require("vscode");
  const cfg = vscode.workspace.getConfiguration("forge");
  return {
    serviceKeyPath: cfg.get<string>("serviceKeyPath", ""),
    deploymentId: cfg.get<string>("deploymentId", ""),
    resourceGroup: cfg.get<string>("resourceGroup", "default"),
    apiVersion: cfg.get<string>("apiVersion", "2024-10-21"),
  };
}

export async function chat(
  messages: Message[],
  tools: ToolSchema[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const { serviceKeyPath, deploymentId, resourceGroup, apiVersion } = readConfig();
  const key = loadServiceKey(serviceKeyPath);
  const url = `${key.serviceurls.AI_API_URL}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=${apiVersion}`;

  let attempt = 0;
  let retriedAfter401 = false;

  for (;;) {
    if (signal?.aborted) throw new Error("Aborted");
    const token = await getToken(key);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "AI-Resource-Group": resourceGroup,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages, tools, tool_choice: "auto", stream: true }),
      signal,
    });

    if (res.status === 401 && !retriedAfter401) {
      retriedAfter401 = true;
      invalidateToken();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      attempt++;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`AI Core request failed: ${res.status} ${await res.text()}`);
    }

    return readStream(res, onDelta);
  }
}

async function readStream(res: Response, onDelta: (text: string) => void): Promise<AssistantMessage> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let toolCalls: ToolCall[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitSSEBuffer(buffer);
    buffer = rest;
    for (const event of events) {
      for (const data of extractDataLines(event)) {
        if (data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (delta.tool_calls) {
          toolCalls = mergeToolCallDelta(toolCalls, delta.tool_calls);
        }
      }
    }
  }

  return { role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined };
}
