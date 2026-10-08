import assert from "node:assert/strict";
import { test } from "node:test";

import { ReconcileError, parsePluginList, type PluginEntry } from "./plugin-contract.mts";

function row(id: string, scope: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, version: "1.0.0", scope, enabled: true, installPath: "/plugins/example", ...overrides };
}

function collect(raw: unknown): { plugins: Map<string, PluginEntry>; unmanaged: PluginEntry[] } {
  const unmanaged: PluginEntry[] = [];
  const plugins = parsePluginList(raw, (entry) => unmanaged.push(entry));
  return { plugins, unmanaged };
}

test("synced is a known read-only scope: rows parse and stay out of the user-scope lookup", () => {
  const { plugins, unmanaged } = collect([row("alpha@main", "user"), row("design@synced", "synced")]);
  assert.deepEqual([...plugins.keys()], ["alpha@main\0user", "design@synced\0synced"]);
  assert.deepEqual(unmanaged, []);
});

test("an unknown future scope is reported and skipped, not fatal", () => {
  const { plugins, unmanaged } = collect([row("alpha@main", "user"), row("beta@main", "org")]);
  assert.deepEqual([...plugins.keys()], ["alpha@main\0user"]);
  assert.deepEqual(unmanaged.map((entry) => [entry.id, entry.scope]), [["beta@main", "org"]]);
});

test("a malformed row stays fatal whatever its scope", () => {
  const malformed: unknown[] = [
    row("alpha@main", 42),
    row("alpha@main", "scope with\nnewline"),
    row("alpha@main", "synced", { enabled: "yes" }),
    row("alpha@main", "org", { installPath: "" }),
    { ...row("alpha@main", "org"), id: undefined },
  ];
  for (const entry of malformed) {
    assert.throws(() => parsePluginList([row("alpha@main", "user"), entry]), ReconcileError);
  }
});

test("duplicate detection covers synced rows", () => {
  assert.throws(() => parsePluginList([row("design@synced", "synced"), row("design@synced", "synced")]), ReconcileError);
});
