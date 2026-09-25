import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { writeLocalSessions } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import { listenerDir, runWake, wakeAudit, type WakeDeps } from "./wake-hook.mts";

// Shared fixture of the wake listener tests (wake-hook.test.mts,
// wake-guards.test.mts): a throwaway node directory, a fake clock and sleep.

const PEER = "00000000-0000-4000-8000-0000000000cc";
export const SELF = "s-self";
export const SECRET = "peer text that must never reach the audit";
export const T0 = Date.UTC(2026, 8, 25, 12);
export const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

// An enrolled node whose policy wakes "review", or has the given wake section
// (absent when options.wake is present but undefined).
export function setup(t: test.TestContext, options: { wake?: unknown; enrolled?: boolean } = {}) {
  const wake = "wake" in options ? options.wake : { enabled: true, sessions: ["review"] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-wake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  if (options.enrolled ?? true) {
    writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "idle", name: "review" }]);
    writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
      name: "n", publicKey: "", privateKeyFile: "", policyFile: paths.policy, enrolledAt: new Date(T0).toISOString() });
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], ...(wake === undefined ? {} : { wake }) }));
  }
  return { root, paths };
}

export function arrive(paths: NodePaths, n: number, at: number, toSession = "review", depth = 0): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession, text: `${SECRET} ${n}`,
    createdAt: new Date(at).toISOString() }, at, depth);
  return id(n);
}

export interface ListenOptions {
  start?: number; tick?: (clock: number) => void; maxWaitMs?: number; event?: string; mode?: string; token?: string;
  parentAlive?: () => boolean;
}

// A listener on a fake clock; tick(clock) runs after each sleep, before the poll.
// The Stop input carries stop_hook_active true in a turn a Stop hook continued,
// the woken turn included; the listener arms all the same.
export function listen(paths: NodePaths, options: ListenOptions = {}) {
  let clock = options.start ?? T0;
  const deps: WakeDeps = {
    paths, pid: 4242, maxWaitMs: options.maxWaitMs ?? 60_000, now: () => clock, parentAlive: options.parentAlive ?? (() => true),
    sleep: async (ms) => { clock += ms; options.tick?.(clock); }, ...(options.token ? { token: () => options.token as string } : {}),
  };
  return runWake({ session_id: SELF, hook_event_name: options.event ?? "Stop", stop_hook_active: true,
    permission_mode: options.mode ?? "default" }, deps);
}

export const auditLines = (paths: NodePaths) =>
  fs.existsSync(wakeAudit(paths)) ? fs.readFileSync(wakeAudit(paths), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
export const lockFile = (paths: NodePaths) => path.join(listenerDir(paths), `${SELF}.json`);
