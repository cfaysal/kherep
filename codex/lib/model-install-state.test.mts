import assert from "node:assert/strict";
import { test } from "node:test";
import { selectModelResolution } from "./model-install-state.mts";
import { fixtureModels, fixtureResolution, policyText } from "./model-policy.fixture.mts";

test("normal reinstall retains its verified resolution even when a newer catalog is supplied", () => {
  const existing = fixtureResolution();
  const catalog = { complete: true, models: [...fixtureModels, { ...fixtureModels[1], id: "gpt-7-sol", model: "gpt-7-sol" }] };
  assert.deepEqual(selectModelResolution(policyText, { existing, catalog }), existing);
  assert.equal(selectModelResolution(policyText, { existing, catalog, refresh: true }).roles.builder.model, "gpt-7-sol");
});

test("first install and refresh require complete catalog evidence before any projection writes", () => {
  assert.throws(() => selectModelResolution(policyText), /complete model catalog/);
  assert.throws(() => selectModelResolution(policyText, { existing: fixtureResolution(), refresh: true }), /complete model catalog/);
  assert.equal(selectModelResolution(policyText, { catalog: { complete: true, models: fixtureModels } }).roles.designer.model, "gpt-6-astra");
});

test("corrupt or stale persisted resolution fails closed rather than silently selecting new models", () => {
  const existing = fixtureResolution();
  for (const value of [{ ...existing, policySha256: "0".repeat(64) }, { ...existing, roles: {} },
    { ...existing, supportedModels: {} }, { ...existing, catalogSha256: "broken" }]) {
    assert.throws(() => selectModelResolution(policyText, { existing: value }), /resolution/);
  }
});
