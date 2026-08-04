import { getToken, invalidateToken } from "./auth.ts";
import { splitSSEBuffer, mergeToolCallDelta, extractDataLines } from "./sse.ts";
import { HttpError } from "./errors.ts";
import { loadServiceKey, readConfig } from "./config.ts";
import { resolveDeploymentId, discardPinnedDeployment } from "./models.ts";
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

  let attempt = 0;
  let retriedAfter401 = false;
  let retriedAfter404 = false;

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

    if (res.status === 401 && !retriedAfter401) {
      retriedAfter401 = true;
      invalidateToken();
      continue;
    }
    // A 404 on this path means the deployment id is gone — most often because
    // the model was redeployed and issued a new one. Re-resolve from the chosen
    // model and try once more, rather than making the user discover that a
    // number they pasted months ago has expired.
    if (res.status === 404 && !retriedAfter404) {
      retriedAfter404 = true;
      discardPinnedDeployment();
      const fresh = await resolveDeploymentId(signal);
      if (fresh !== deploymentId) {
        deploymentId = fresh;
        continue;
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      attempt++;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
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
