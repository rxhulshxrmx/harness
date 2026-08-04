// No `vscode` import — pure and unit-testable, same split as sse.ts/errors.ts.
//
// The two URLs in a SAP AI Core service key are pasted by hand, and the most
// common reason "my credentials are correct but it will not connect" is that
// the pasted value carries a suffix this extension appends itself: the auth URL
// with `/oauth/token` already on it becomes `.../oauth/token/oauth/token`, and
// the API URL with `/v2` on it becomes `.../v2/v2/inference/...`. Both fail with
// a 404 that reads nothing like "you pasted one segment too many", so normalise
// on the way in instead of asking the user to spot it.

function trimUrl(raw: string): string {
  // Quotes come along when the value is copied out of the service-key JSON.
  let url = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!url) return "";
  url = url.split("#")[0].split("?")[0];
  url = url.replace(/\/+$/, "");
  if (!url) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/**
 * The XSUAA base, with no `/oauth/token` on the end — getToken appends that.
 */
export function normalizeAuthUrl(raw: string): string {
  const url = trimUrl(raw);
  if (!url) return "";
  return url.replace(/\/oauth\/token$/i, "").replace(/\/+$/, "");
}

/**
 * The AI API base, with no `/v2...` on the end — the callers append the
 * versioned path themselves.
 */
export function normalizeApiUrl(raw: string): string {
  const url = trimUrl(raw);
  if (!url) return "";
  return url.replace(/\/v2(\/(lm|inference)(\/deployments)?)?$/i, "").replace(/\/+$/, "");
}
