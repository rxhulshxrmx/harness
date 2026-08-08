import { getHost } from "../host.ts";
import { normalizeAuthUrl, normalizeApiUrl } from "./urls.ts";
import type { ServiceKey } from "./types.ts";

export const CLIENT_SECRET_KEY = "couplet.clientSecret";

// Credentials are entered as separate fields (Client ID, Client Secret, AI Core
// Base URL, Auth URL, Resource Group) in the settings panel, matching how SAP
// AI Core credentials are actually issued — rather than requiring a path to a
// downloaded service-key JSON file. Only the secret goes through SecretStorage;
// the rest are plain (non-secret) identifiers/URLs.
//
// Lives in its own module rather than in client.ts so models.ts can read the
// same config without the two files importing each other in a cycle.

/** Names the missing pieces, so the error says what to go and fix. */
export function missingCredentialFields(fields: {
  clientid: string;
  clientsecret: string;
  authUrl: string;
  apiUrl: string;
}): string[] {
  const missing: string[] = [];
  if (!fields.clientid) missing.push("Client ID");
  if (!fields.clientsecret) missing.push("Client secret");
  if (!fields.apiUrl) missing.push("AI Core base URL");
  if (!fields.authUrl) missing.push("Auth URL");
  return missing;
}

export async function loadServiceKey(): Promise<ServiceKey> {
  const host = getHost();
  const clientid = host.getConfig("clientId", "").trim();
  const authUrl = normalizeAuthUrl(host.getConfig("tokenUrl", ""));
  const apiUrl = normalizeApiUrl(host.getConfig("aiCoreBaseUrl", ""));
  const clientsecret = ((await host.getSecret(CLIENT_SECRET_KEY)) ?? "").trim();

  const missing = missingCredentialFields({ clientid, clientsecret, authUrl, apiUrl });
  if (missing.length) {
    throw new Error(
      `SAP AI Core credentials are incomplete — missing ${missing.join(", ")}. Open Couplet settings (gear icon) to add them, or set the equivalent COUPLET_* environment variables in headless mode.`,
    );
  }
  return { clientid, clientsecret, url: authUrl, serviceurls: { AI_API_URL: apiUrl } };
}

export function readConfig() {
  const host = getHost();
  return {
    // Deliberately not declared in package.json's contributes.configuration, so
    // it does not appear in the settings UI as something to fill in — there is
    // nothing here a user should have to find. It is still read, as a rescue
    // hatch for a tenant whose deployment cannot be discovered: setting it by
    // hand in settings.json pins that id. Empty (the normal case) means resolve
    // it from the chosen model — see resolveDeploymentId in models.ts.
    deploymentId: host.getConfig("deploymentId", "").trim(),
    resourceGroup: host.getConfig("resourceGroup", "default").trim() || "default",
    apiVersion: host.getConfig("apiVersion", "2024-10-21"),
    model: host.getConfig("model", "").trim(),
  };
}
