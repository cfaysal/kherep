import assert from "node:assert/strict";
import { test } from "node:test";
import { collectModelCatalog } from "./model-catalog.mts";

const entry = { id: "gpt-6-sol", model: "gpt-6-sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] };
function client(pages: unknown[]) {
  const calls: { method: string; params?: unknown }[] = [];
  let closed = false;
  return {
    calls, get closed() { return closed; },
    async request(method: string, params: unknown) { calls.push({ method, params }); return method === "initialize" ? {} : pages.shift(); },
    notify(method: string) { calls.push({ method }); },
    async shutdown() { closed = true; return true; },
  };
}
test("catalog collector initializes once and exhausts model/list pagination only", async () => {
  const port = client([{ data: [entry], nextCursor: "next" }, { data: [{ ...entry, id: "terra", model: "gpt-6-terra" }], nextCursor: null }]);
  const result = await collectModelCatalog(port);
  assert.equal(result.complete, true);
  assert.equal(result.models.length, 2);
  assert.deepEqual(port.calls.map(({ method }) => method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.deepEqual(port.calls[2].params, { limit: 100, includeHidden: false });
  assert.deepEqual(port.calls[3].params, { limit: 100, includeHidden: false, cursor: "next" });
  assert.equal(port.closed, true);
});

test("collector emits only whitelisted metadata from every page", async () => {
  const port = client([{ data: [{ ...entry, accountDetail: "synthetic-unknown-entry", supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "synthetic-unknown-effort" },
  ] }], nextCursor: null, accountDetail: "synthetic-unknown-page" }]);
  const result = await collectModelCatalog(port);
  assert.deepEqual(result, { complete: true, models: [entry] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-unknown/);
});
test("invalid pages, repeated cursors, caps and unconfirmed cleanup fail closed", async () => {
  for (const pages of [[{ data: [entry] }], [{ data: [], nextCursor: "a" }, { data: [], nextCursor: "a" }],
    [{ data: [entry], nextCursor: null }, { data: [], nextCursor: null }]]) {
    const port = client(pages);
    if (pages.length === 2 && (pages[0] as { nextCursor: unknown }).nextCursor === null) port.shutdown = async () => false;
    await assert.rejects(collectModelCatalog(port), /catalog|cursor|cleanup/i);
    if (port.closed) assert.equal(port.closed, true);
  }
  const port = client([{ data: [], nextCursor: "more" }]);
  await assert.rejects(collectModelCatalog(port, { maxPages: 1 }), /page limit/);
  assert.equal(port.closed, true);
});
