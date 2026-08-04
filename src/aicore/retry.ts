// No `vscode` import — pure and unit-testable, same split as sse.ts/errors.ts.
//
// The whole retry policy for an inference request, in one place. It used to be
// three interleaved conditions inside the fetch loop, where the only way to
// check "does a dead deployment really get re-resolved exactly once?" was to
// have a dead deployment.

export const MAX_BACKOFF_ATTEMPTS = 3;

export type RetryDecision =
  | { action: "proceed" }
  | { action: "refresh-token" }
  | { action: "reresolve-deployment" }
  | { action: "backoff"; delayMs: number }
  | { action: "fail" };

export interface RetryState {
  /** How many backoff attempts have already been spent. */
  attempt: number;
  triedTokenRefresh: boolean;
  triedDeploymentReresolve: boolean;
}

export function decideRetry(status: number, state: RetryState): RetryDecision {
  if (status >= 200 && status < 300) return { action: "proceed" };

  // Once only: a second 401 after a fresh token means the credentials are
  // wrong, not stale, and retrying forever would just spin.
  if (status === 401 && !state.triedTokenRefresh) return { action: "refresh-token" };

  // A 404 on the inference path means the deployment id no longer exists —
  // usually a redeploy issued a new one.
  if (status === 404 && !state.triedDeploymentReresolve) return { action: "reresolve-deployment" };

  if ((status === 429 || status >= 500) && state.attempt < MAX_BACKOFF_ATTEMPTS) {
    return { action: "backoff", delayMs: 1000 * 2 ** state.attempt };
  }

  return { action: "fail" };
}
