import { getToken } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { loadServiceKey, readConfig } from "./client.ts";

export interface Deployment {
  id: string;
  modelName: string;
  // "gpt-4o:2024-08-06" — name plus version, which is what distinguishes two
  // deployments of the same model.
  label: string;
}

// Pure so it can be tested without a live endpoint. Shape follows SAP AI
// Core's /v2/lm/deployments response: a `resources` array where the model
// sits at details.resources.backend_details.model. Only RUNNING deployments
// can actually serve inference, so anything else is dropped, as are entries
// with no model block (orchestration deployments, custom scenarios).
export function parseDeployments(body: unknown): Deployment[] {
  const resources = (body as { resources?: unknown })?.resources;
  if (!Array.isArray(resources)) return [];

  const found: Deployment[] = [];
  for (const entry of resources) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, any>;
    if (r.targetStatus !== "RUNNING") continue;
    if (typeof r.id !== "string" || !r.id) continue;

    const model = r.details?.resources?.backend_details?.model;
    const name = model?.name;
    if (typeof name !== "string" || !name) continue;
    const version = typeof model?.version === "string" ? model.version : "";

    found.push({ id: r.id, modelName: name, label: version ? `${name}:${version}` : name });
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

export async function listDeployments(signal?: AbortSignal): Promise<Deployment[]> {
  const key = await loadServiceKey();
  const { resourceGroup } = readConfig();
  const token = await getToken(key);

  const url = `${key.serviceurls.AI_API_URL}/v2/lm/deployments?$top=10000&$skip=0`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "AI-Resource-Group": resourceGroup,
      "Content-Type": "application/json",
    },
    signal,
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return parseDeployments(await res.json());
}
