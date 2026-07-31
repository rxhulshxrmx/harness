// No `vscode` import — pure and unit-testable, same split as sse.ts.

export type ErrorCategory = "aborted" | "auth" | "rate_limit" | "context_too_long" | "network" | "server" | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
}

// Thrown by aicore/client.ts for a non-ok HTTP response, carrying enough
// detail (status + body) for classifyError to distinguish auth/rate-limit/
// context-length/server errors instead of collapsing them into one generic
// Error message.
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`AI Core request failed: ${status} ${body}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

const CONTEXT_LENGTH_RE = /context.?length|maximum context|context window|too many tokens/i;
const NETWORK_RE = /network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed/i;

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof Error && (err.name === "AbortError" || err.message === "Aborted")) {
    return { category: "aborted", message: "Stopped.", retryable: false };
  }

  if (err instanceof HttpError) {
    if (err.status === 401) {
      return { category: "auth", message: "Authentication failed — check harness.serviceKeyPath.", retryable: false };
    }
    if (err.status === 429) {
      return { category: "rate_limit", message: "Rate limited by the model provider.", retryable: true };
    }
    if (CONTEXT_LENGTH_RE.test(err.body)) {
      return {
        category: "context_too_long",
        message: "The conversation is too long for the model's context window.",
        retryable: false,
      };
    }
    if (err.status >= 500) {
      return { category: "server", message: `Model provider server error (${err.status}).`, retryable: true };
    }
    return { category: "unknown", message: err.message, retryable: false };
  }

  if (err instanceof Error && NETWORK_RE.test(err.message)) {
    return { category: "network", message: "Network error reaching the model provider.", retryable: true };
  }

  return { category: "unknown", message: err instanceof Error ? err.message : String(err), retryable: false };
}
