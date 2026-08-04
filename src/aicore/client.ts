import { getToken, invalidateToken } from "./auth.ts";
import { splitSSEBuffer, mergeToolCallDelta, extractDataLines } from "./sse.ts";
import { HttpError } from "./errors.ts";
import { loadServiceKey, readConfig } from "./config.ts";
import { resolveDeploymentId, discardPinnedDeployment } from "./models.ts";
import { decideRetry, type RetryState } from "./retry.ts";
import type { Message, AssistantMessage, ToolSchema, ToolCall } from "./types.ts";

export { CLIENT_SECRET_KEY, loadServiceKey, readConfig } from "./config.ts";

export async function chat(
  messages: Message[],
  tools: ToolSchema[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const { resourceGroup, apiVersion } = readConfig();
  const key = await loadServiceKey();
  // Resolved from the chosen model rather than configured by hand.
  let deploymentId = await resolveDeploymentId(signal);
  const endpoint = (id: string) =>
    `${key.serviceurls.AI_API_URL}/v2/inference/deployments/${id}/chat/completions?api-version=${apiVersion}`;

  const retry: RetryState = { attempt: 0, triedTokenRefresh: false, triedDeploymentReresolve: false };

  for (;;) {
    if (signal?.aborted) throw new Error("Aborted");
    const token = await getToken(key);
    const res = await fetch(endpoint(deploymentId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "AI-Resource-Group": resourceGroup,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages, tools, tool_choice: "auto", stream: true }),
      signal,
    });

    const decision = decideRetry(res.status, retry);
    if (decision.action === "refresh-token") {
      retry.triedTokenRefresh = true;
      invalidateToken();
      continue;
    }
    if (decision.action === "reresolve-deployment") {
      // The deployment id is gone — most often because the model was
      // redeployed and issued a new one. Re-resolve from the chosen model
      // rather than making the user discover that a number they pasted months
      // ago has expired. Only worth another request if it actually changed.
      retry.triedDeploymentReresolve = true;
      discardPinnedDeployment();
      const fresh = await resolveDeploymentId(signal);
      if (fresh !== deploymentId) {
        deploymentId = fresh;
        continue;
      }
    }
    if (decision.action === "backoff") {
      retry.attempt++;
      await new Promise((r) => setTimeout(r, decision.delayMs));
      continue;
    }
    if (!res.ok) {
      throw new HttpError(res.status, await res.text());
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
