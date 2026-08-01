import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeployments } from "./models.ts";

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
