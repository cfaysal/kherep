import { parseModelPolicy, record, resolveModels, type ModelResolution } from "./model-policy.mts";

export interface ModelSelection { existing?: unknown; catalog?: unknown; refresh?: boolean }

// A normal reinstall never refreshes model identities. This pure preflight runs
// before the install transaction; a changed policy needs an explicit refresh.
export function selectModelResolution(policyText: string, selection: ModelSelection = {}): ModelResolution {
  const policy = parseModelPolicy(policyText);
  if (selection.refresh !== true && selection.existing !== undefined) {
    const value = selection.existing;
    if (!record(value) || value.schemaVersion !== 1 || value.policySha256 !== policy.sourceSha256
      || typeof value.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogSha256)
      || typeof value.resolvedAt !== "string" || !Number.isFinite(Date.parse(value.resolvedAt))
      || !record(value.roles) || !record(value.supportedModels)) throw new Error("Installed model resolution is invalid or requires explicit refresh");
    const models = Object.entries(value.supportedModels).map(([model, efforts]) => ({
      id: model, model, hidden: false,
      supportedReasoningEfforts: Array.isArray(efforts) ? efforts.map((reasoningEffort: unknown) => ({ reasoningEffort })) : [],
    }));
    let checked: ModelResolution;
    try { checked = resolveModels(policy, { complete: true, models }); }
    catch { throw new Error("Installed model resolution support is invalid"); }
    if (JSON.stringify(checked.roles) !== JSON.stringify(value.roles)) throw new Error("Installed model resolution roles are inconsistent");
    return value as unknown as ModelResolution;
  }
  if (selection.catalog === undefined) throw new Error("A complete model catalog is required for first install or explicit refresh");
  return resolveModels(policy, selection.catalog);
}
