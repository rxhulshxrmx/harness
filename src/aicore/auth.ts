import type { ServiceKey } from "./types.ts";

let cached: { token: string; expiresAt: number } | null = null;

export async function getToken(key: ServiceKey): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch(`${key.url}/oauth/token?grant_type=client_credentials`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${key.clientid}:${key.clientsecret}`).toString("base64"),
    },
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

export function invalidateToken(): void {
  cached = null;
}
