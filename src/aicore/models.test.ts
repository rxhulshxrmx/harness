import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeployments, pickDeployment } from "./models.ts";

function deployment(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    targetStatus: "RUNNING",
    details: { resources: { backend_details: { model: { name: "gpt-4o", version: "2024-08-06" } } } },
    ...over,
  };
}

test("extracts running deployments as name:version", () => {
  const out = parseDeployments({ resources: [deployment()] });
  assert.deepEqual(out, [{ id: "d1", modelName: "gpt-4o", label: "gpt-4o:2024-08-06" }]);
});

test("skips deployments that are not RUNNING", () => {
  const out = parseDeployments({
    resources: [deployment({ id: "a", targetStatus: "STOPPED" }), deployment({ id: "b" })],
  });
  assert.deepEqual(out.map((d) => d.id), ["b"]);
});

test("skips entries with no model block, such as orchestration deployments", () => {
  const out = parseDeployments({
    resources: [
      { id: "orch", targetStatus: "RUNNING", scenarioId: "orchestration", details: { resources: {} } },
      deployment({ id: "real" }),
    ],
  });
  assert.deepEqual(out.map((d) => d.id), ["real"]);
});

test("falls back to the bare name when no version is present", () => {
  const out = parseDeployments({
    resources: [deployment({ details: { resources: { backend_details: { model: { name: "mistral" } } } } })],
  });
  assert.equal(out[0].label, "mistral");
});

test("sorts by label so the picker order is stable", () => {
  const out = parseDeployments({
    resources: [
      deployment({ id: "c", details: { resources: { backend_details: { model: { name: "zephyr", version: "1" } } } } }),
      deployment({ id: "a", details: { resources: { backend_details: { model: { name: "claude", version: "3" } } } } }),
    ],
  });
  assert.deepEqual(out.map((d) => d.label), ["claude:3", "zephyr:1"]);
});

test("returns an empty list for malformed or empty payloads", () => {
  for (const body of [null, undefined, {}, { resources: "nope" }, { resources: [] }, { resources: [null, 42] }]) {
    assert.deepEqual(parseDeployments(body), []);
  }
});

const list = [
  { id: "a", modelName: "gpt-4o", label: "gpt-4o:2024-08-06" },
  { id: "b", modelName: "gpt-4o-mini", label: "gpt-4o-mini:2024-07-18" },
  { id: "c", modelName: "mistral", label: "mistral" },
];

test("picks the deployment whose label matches the chosen model", () => {
  assert.equal(pickDeployment(list, "gpt-4o:2024-08-06")?.id, "a");
  assert.equal(pickDeployment(list, "mistral")?.id, "c");
});

test("a bare model name matches its versioned deployment", () => {
  assert.equal(pickDeployment(list, "gpt-4o")?.id, "a");
});

test("a bare name never falls through to a longer one that starts the same", () => {
  assert.equal(pickDeployment(list, "gpt-4o")?.id, "a", "gpt-4o must not resolve to gpt-4o-mini");
  assert.equal(pickDeployment(list, "gpt-4o-mini")?.id, "b");
});

test("model names are matched case-insensitively", () => {
  assert.equal(pickDeployment(list, "GPT-4o")?.id, "a");
});

test("an unset model falls back to the first deployment", () => {
  assert.equal(pickDeployment(list, "")?.id, "a");
  assert.equal(pickDeployment(list, "   ")?.id, "a");
});

test("a model that is not deployed resolves to nothing, not to another model", () => {
  assert.equal(pickDeployment(list, "llama-3"), undefined);
});

test("an empty deployment list resolves to nothing", () => {
  assert.equal(pickDeployment([], "gpt-4o"), undefined);
});
