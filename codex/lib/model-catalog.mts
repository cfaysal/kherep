import { record, validateCatalog, type ModelCatalog } from "./model-policy.mts";

export interface CatalogClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  shutdown(): Promise<boolean>;
}
export interface CatalogLimits { timeoutMs?: number; maxPages?: number }

// This metadata-only protocol never opens a thread, starts a turn or requests inference.
// The caller owns exactly one app-server and must obtain confirmed cleanup before using the result.
export async function collectModelCatalog(client: CatalogClient, limits: CatalogLimits = {}): Promise<ModelCatalog> {
  const timeoutMs = limits.timeoutMs ?? 10_000;
  const maxPages = limits.maxPages ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
    await client.shutdown();
    throw new Error("Invalid catalog limits");
  }
  const deadline = Date.now() + timeoutMs;
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Model catalog deadline exceeded");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([client.request(method, params, remaining), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Model catalog deadline exceeded")), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    await request("initialize", { clientInfo: { name: "kherep_model_catalog", version: "1" }, capabilities: null });
    client.notify("initialized", {});
    const models: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!record(result) || !Array.isArray(result.data) || result.data.length > 100
        || !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor.length > 0)) {
        throw new Error("Malformed model catalog page");
      }
      models.push(...result.data);
      if (result.nextCursor === null) return validateCatalog({ complete: true, models });
      cursor = result.nextCursor as string;
      if (cursors.has(cursor)) throw new Error("Repeated model catalog cursor");
      cursors.add(cursor);
    }
    throw new Error("Model catalog page limit exceeded");
  } finally {
    if (!await client.shutdown()) throw new Error("Model catalog process cleanup was not confirmed");
  }
}
