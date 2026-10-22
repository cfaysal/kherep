import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { SESSION } from "./closed-fixture.mts";
import { resumeNode } from "./closed-resume-fault-fixture.mts";
import { getMessage, type InboxRecord } from "./inbox.mts";
import { BACKGROUNDED, type RunnerDeps } from "./session-runner.mts";
import type { ExecOptions } from "./sessions.mts";
import type { taskNode } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #639: shared setup of the start/continue session-id tests. The fake
// claude of task-fixture.mts, with the listing rows of the runs launched while
// a variant is armed showing that full id instead (a copied row, the fixture's
// own rows unchanged). Synthetic ids only; no file is named by a malformed id.
type Node = ReturnType<typeof taskNode>;

export const VALID128 = "v".repeat(128);
export const OVERLONG = "x".repeat(129);
export const CONTROL = "bad\nid";
export const BAD_IDS = [OVERLONG, CONTROL];
export const label = (id: string): string => id.length > 100 ? "an overlong" : "a control-bearing";
export const ABSENT = Symbol("no full id");
export const ROWLESS = Symbol("no row");
export type Variant = unknown;

export const iso = (ms: number): string => new Date(ms).toISOString();
export const bgRuns = (node: Node): number => node.calls.filter((c) => c.args[0] === "--bg").length;
export const resumes = (node: Node): string[][] => node.calls.filter((c) => c.args[0] === "--resume").map((c) => c.args);

// onLaunch runs before each native start or resume, with its arguments. A
// variant armed with rename also lists the run under that short id (found by name).
export function listingVariant(node: Node, base: RunnerDeps = node.deps(), onLaunch?: (args: string[]) => void) {
  let variant: { value: Variant; rename?: string } | undefined;
  let failing = false;
  const runs = new Set<string>();
  const exec = async (file: string, args: string[], execOptions: ExecOptions): Promise<string> => {
    if (args[0] === "agents" && failing) throw new Error("synthetic listing failure");
    if (args[0] === "--bg" || args[0] === "--resume") onLaunch?.(args);
    const out = await base.exec!(file, args, execOptions);
    const short = args[0] === "--bg" || args[0] === "--resume" ? BACKGROUNDED.exec(out)?.[1] : undefined;
    if (short && variant) runs.add(short);
    if (args[0] !== "agents" || !variant) return out;
    const { value, rename } = variant;
    return JSON.stringify((JSON.parse(out) as Record<string, unknown>[]).flatMap((row) => {
      if (!runs.has(String(row.id))) return [row];
      if (value === ROWLESS) return [];
      const { sessionId: _listed, ...rest } = row;
      return [{ ...rest, ...(rename ? { id: rename } : {}), ...(value === ABSENT ? {} : { sessionId: value }) }];
    }));
  };
  return {
    deps: { ...base, exec } as RunnerDeps,
    arm: (value: Variant, rename?: string) => { variant = { value, rename }; },
    disarm: () => { variant = undefined; },
    failListing: (on: boolean) => { failing = on; },
  };
}

export interface StoredSource {
  // Merged into the ended intercom task after its stored id was replaced.
  extra?: Partial<TaskRecord>;
  // Merged into the sessions policy before the deps are built.
  sessions?: Record<string, unknown>;
  // A synthetic failure for a budget lock (budgetLocks); control-bearing names always fail.
  fail?: (file: string) => string | null;
}

// Issue #639, R4: the real ended intercom task T of resumeNode with only its
// stored full id replaced (ABSENT: removed), and a second accepted message M
// for the closed target. Budget locks are observed from here on; the message
// is read back at each native launch.
export async function storedSource(t: test.TestContext, stored: Variant, options: StoredSource = {}) {
  const { node, task, id } = await resumeNode(t);
  const { sessionId: _valid, ...rest } = readTask(node.paths, task.taskId)!;
  writeTask(node.paths, { ...rest, ...(stored === ABSENT ? {} : { sessionId: stored as string }), ...options.extra });
  if (options.sessions) {
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as { sessions: Record<string, unknown> };
    fs.writeFileSync(node.paths.policy, JSON.stringify({ ...policy, sessions: { ...policy.sessions, ...options.sessions } }));
  }
  const corrupt = readTask(node.paths, task.taskId)!;
  const turns = turnsOf(node, SESSION);
  const locks = budgetLocks(t, node, (file) => refuseControl(file) ?? options.fail?.(file) ?? null);
  const launched: (InboxRecord | null)[] = [];
  const listing = listingVariant(node, node.deps(), () => launched.push(getMessage(node.paths.inbox, id)));
  return { node, task: corrupt, id, turns, locks, launched, listing };
}

// Budget-lock writes of the turn budget (autonomy.mts takeTurn), observed from
// setup on. fail(file) decides a synthetic error for a lock instead of the
// write, so no file named by a malformed id is ever created.
export function budgetLocks(t: test.TestContext, node: Node, fail: (file: string) => string | null = () => null): string[] {
  const seen: string[] = [];
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    const file = typeof args[0] === "string" ? args[0] : "";
    if (path.dirname(file) === listenerDir(node.paths) && file.endsWith(".turns.json.lock")) {
      seen.push(path.basename(file, ".turns.json.lock"));
      const code = fail(file);
      if (code) throw Object.assign(new Error(`synthetic ${code} budget lock failure`), { code });
    }
    return write(...args);
  });
  return seen;
}

// The turns the budget of sessionId holds.
export function turnsOf(node: Node, sessionId: string): number {
  const file = path.join(listenerDir(node.paths), `${sessionId}.turns.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: number[] }).turns.length : 0;
}

// A control-bearing lock name fails as Windows refuses it (EINVAL).
export const refuseControl = (file: string): string | null => /[\u0000-\u001f\u007f]/.test(path.basename(file)) ? "EINVAL" : null;
