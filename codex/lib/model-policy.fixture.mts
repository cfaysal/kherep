import fs from "node:fs";
import { parseModelPolicy, resolveModels } from "./model-policy.mts";

export const policyText = fs.readFileSync(new URL("../parity/model-policy.toml", import.meta.url), "utf8");
export const fixtureModels = ["gpt-6-astra", "gpt-6.9-sol", "gpt-6.10-sol", "gpt-5.6-terra", "gpt-6-luna"].map((model) => ({
  id: model, model, hidden: false,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })),
}));
export function fixtureResolution() { return resolveModels(parseModelPolicy(policyText), { complete: true, models: fixtureModels }); }

// Every programmatic install test supplies its own offline catalog. Cloning
// prevents refresh or malformed-catalog cases from mutating another fixture.
export function fixtureModelCatalog() { return { complete: true as const, models: structuredClone(fixtureModels) }; }
export function fixtureModelOptions() { return { modelCatalog: fixtureModelCatalog() }; }
