import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { ACK_DIAGNOSTICS_MAX_BYTES, processMcpIntentHook } from "./mcp-intent-hook.mts";
import { recordMcpIntentReceipt } from "./mcp-local.mts";

const SESSION = "synthetic-timing-session";
const CALL = "synthetic-timing-call";
const BODY = "SYNTHETIC_TIMING_BODY";
const HOOK_SHA256 = createHash("sha256").update(fs.readFileSync(path.join(import.meta.dirname, "mcp-intent-hook.mts"))).digest("hex");

function enabled(t: test.TestContext): { root: string; paths: NodePaths; diagnostics: string; log: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-ack-timing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const diagnostics = path.join(paths.mcp, "diagnostics");
  return { root, paths, diagnostics, log: path.join(diagnostics, "ack-latency.jsonl") };
}

const input = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__send", session_id: SESSION,
  tool_use_id: CALL, tool_input: { to: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" }, text: BODY } };

async function queued(paths: NodePaths): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const [name] = fs.readdirSync(paths.mcpIntents).filter((entry) => /^[0-9a-f-]{36}\.json$/.test(entry));
      if (name) return name.slice(0, -5);
    } catch { /* created asynchronously */ }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("intent was not queued");
}

function records(file: string): Record<string, unknown>[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("ACK timing stays off and writes nothing without the operator diagnostics directory", async (t) => {
  const { root, paths, diagnostics } = enabled(t);
  const pending = processMcpIntentHook(input, root);
  const requestId = await queued(paths);
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: true, expiresAt: Date.now() + 120_000, version: 1 });
  assert.equal((await pending)?.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(fs.existsSync(diagnostics), false);
});

test("opt-in ACK timing records the monotonic receipt wait of a native send without identifiers or body", async (t) => {
  const { root, paths, diagnostics, log } = enabled(t);
  fs.mkdirSync(diagnostics, { recursive: true });
  const pending = processMcpIntentHook(input, root);
  const requestId = await queued(paths);
  await new Promise((resolve) => setTimeout(resolve, 60));
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: true, expiresAt: Date.now() + 120_000, version: 1 });
  const output = await pending;
  assert.deepEqual(output?.hookSpecificOutput.updatedInput, { ...input.tool_input, requestId });

  const [record, ...rest] = records(log);
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(record!).sort(),
    ["ackWaitMs", "at", "hookMs", "hookSha256", "method", "outcome", "pollIntervalMs", "runtime", "tool"]);
  assert.equal(record!.method, "hook-intent-receipt");
  assert.equal(record!.runtime, "codex");
  assert.equal(record!.tool, "send");
  assert.equal(record!.outcome, "accepted");
  assert.equal(record!.pollIntervalMs, 25);
  assert.equal(record!.hookSha256, HOOK_SHA256);
  const ackWaitMs = record!.ackWaitMs as number;
  assert.ok(ackWaitMs >= 50 && ackWaitMs < 8_000, `ackWaitMs ${ackWaitMs}`);
  assert.ok((record!.hookMs as number) >= ackWaitMs);
  const raw = fs.readFileSync(log, "utf8");
  for (const value of [requestId, SESSION, CALL, BODY]) assert.equal(raw.includes(value), false, value);
});

test("opt-in ACK timing labels rejected and timed-out receipts without changing the decision", async (t) => {
  const { root, paths, diagnostics, log } = enabled(t);
  fs.mkdirSync(diagnostics, { recursive: true });
  const pending = processMcpIntentHook(input, root);
  const requestId = await queued(paths);
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: false, error: "synthetic-rejection" });
  assert.equal((await pending)?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_intent_rejected");

  const timeout = await processMcpIntentHook({ ...input, tool_use_id: "synthetic-timeout-call" }, root, Date.now() - 7_900);
  assert.equal(timeout?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_intent_ack_timeout");
  const [rejected, timedOut] = records(log);
  assert.equal(rejected!.outcome, "rejected");
  assert.equal(timedOut!.outcome, "timeout");
  assert.ok((timedOut!.ackWaitMs as number) >= 0);
});

test("opt-in ACK timing is bounded by one rotation and ignores a symlinked diagnostics directory", async (t) => {
  const { root, paths, diagnostics, log } = enabled(t);
  fs.mkdirSync(diagnostics, { recursive: true });
  fs.writeFileSync(log, "x".repeat(ACK_DIAGNOSTICS_MAX_BYTES));
  const timeout = () => processMcpIntentHook(input, root, Date.now() - 7_950);
  await timeout();
  assert.equal(fs.statSync(`${log}.1`).size, ACK_DIAGNOSTICS_MAX_BYTES);
  assert.equal(records(log).length, 1);

  if (process.platform === "win32") return;
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-ack-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.rmSync(diagnostics, { recursive: true });
  fs.symlinkSync(elsewhere, diagnostics);
  await timeout();
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
