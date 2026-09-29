import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { normalizePayloads, type HookPayload } from "./hook-adapter.mts";
import { evaluate } from "./privacy-boundary-guard.mts";

const cwd = path.resolve("fixture-workspace");
const env = { HOME: cwd, USERPROFILE: cwd, KHEREP_CREDENTIALS_ROOT: path.join(cwd, "vault") };
function patch(body: string): string { return `*** Begin Patch\n${body}\n*** End Patch`; }
const update = "*** Update File: src/example.mts\n@@\n-old\n+new";
const wrap = [
  (input: string): unknown => input,
  (input: string): unknown => ({ input }),
  (input: string): unknown => ({ patch: input }),
  (input: string): unknown => ({ command: input }),
];
function normalize(input: unknown): HookPayload[] {
  return normalizePayloads({ cwd, tool_name: "apply_patch", tool_input: input }, "pre-privacy");
}
function run(input: unknown): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [
    path.join(import.meta.dirname, "hook-adapter.mts"),
    path.join(import.meta.dirname, "privacy-boundary-guard.mts"), "pre-privacy",
  ], { input: JSON.stringify({ cwd, tool_name: "apply_patch", tool_input: input }),
    encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
}

for (const [index, shape] of wrap.entries()) {
  test(`allows public apply_patch input shape ${index} through the real hook`, () => {
    const input = shape(patch(update));
    const payloads = normalize(input);
    assert.equal(payloads.length, 1);
    const file = payloads[0].tool_input as { file_path: string };
    assert.equal(file.file_path, path.join(cwd, "src/example.mts"));
    assert.equal(evaluate(payloads[0], env), null);
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });
}

test("checks every add, update, delete and move target without changing path text", () => {
  const input = patch([
    "*** Add File: src/new file.mts", "+new",
    "*** Update File: src/old.mts", "*** Move to: src/owner's new.mts", "@@", "-old", "+new",
    "*** Delete File: src/gone.mts",
  ].join("\n"));
  const payloads = normalize({ input });
  assert.deepEqual(payloads.map(p => (p.tool_input as { file_path: string }).file_path), [
    "src/new file.mts", "src/old.mts", "src/owner's new.mts", "src/gone.mts",
  ].map(p => path.join(cwd, p)));
  assert.ok(payloads.every(p => evaluate(p, env) === null));
});

test("keeps private targets blocked, including a later operation and a move destination", () => {
  for (const body of [
    "*** Add File: vault/fixture.txt\n+example",
    `${update}\n*** Delete File: vault/fixture.txt`,
    "*** Update File: src/example.mts\n*** Move to: vault/fixture.txt\n@@\n-old\n+new",
  ]) {
    const result = run({ input: patch(body) });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.match(output.permissionDecisionReason, /Private material/);
  }
});

test("keeps the complete patch and wrapper visible to privacy classification", () => {
  const privatePath = path.join(cwd, "vault", "fixture.txt");
  for (const input of [
    { input: patch(`${update}\n+${privatePath}`) },
    { input: patch(update), extra: privatePath },
    { command: patch(`${update}\n+${privatePath}`) },
    { command: patch(update), extra: privatePath },
  ]) {
    assert.ok(normalize(input).every(p => /Private material/.test(evaluate(p, env) ?? "")));
  }
});

test("fails closed when patch framing or any target is missing or malformed", () => {
  for (const input of [null, {}, "", "ordinary text", { input: update },
    { input: "malformed", file_path: path.join(cwd, "public.mts") },
    { command: "malformed", file_path: path.join(cwd, "public.mts") },
    { source: patch(update), file_path: path.join(cwd, "public.mts") },
    patch(""), patch("*** Update File: \n@@\n-old\n+new"),
    patch(`${update}\n*** Delete File: `),
    patch("*** Move to: src/new.mts"),
    patch("*** Add File: src/new.mts\n*** Move to: src/other.mts\n+x"),
    patch(`${update}\n*** Unexpected File: src/new.mts`),
    patch("*** Update File: src/bad\u0000.mts\n@@\n-old\n+new"),
  ]) {
    const payloads = normalize(input);
    assert.ok(payloads.length > 0);
    assert.ok(payloads.some(p => evaluate(p, env) !== null), JSON.stringify(input));
  }
});
