import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import type { CodexDeps } from "./codex-process.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { taskNode } from "./task-fixture.mts";

// A fake codex for the Codex task tests (issue #63): an executable Node script
// that never runs a model. It logs its argv, working directory and whether
// stdin is the null device, then prints `codex exec --json` events. The prompt
// picks the behavior: [sleep] runs until stopped, [ignore-term] also ignores
// SIGTERM, [fail] ends with turn.failed and exit 1, [silent] exits 2 without
// events; otherwise the turn completes, -o gets the last message, exit 0.
// A resume keeps the thread id it was given.

export const THREAD = "0199a000-0000-7000-8000-000000000001";
export const LAST_MESSAGE = "  All tests pass.\n\n";

const SCRIPT = (log: string): string => `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdinNull = fs.fstatSync(0).rdev === fs.statSync("/dev/null").rdev;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), stdinNull, pid: process.pid }) + "\\n");
const prompt = argv[argv.length - 1];
const out = argv[argv.indexOf("-o") + 1];
const thread = argv[1] === "resume" ? argv[argv.length - 2] : ${JSON.stringify(THREAD)};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (prompt.includes("[silent]")) process.exit(2);
emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
if (prompt.includes("[ignore-term]")) process.on("SIGTERM", () => {});
if (prompt.includes("[sleep]") || prompt.includes("[ignore-term]")) setInterval(() => {}, 1000);
else if (prompt.includes("[fail]")) { emit({ type: "turn.failed", error: { message: "model refused" } }); process.exit(1); }
else { fs.writeFileSync(out, ${JSON.stringify(LAST_MESSAGE)}); emit({ type: "turn.completed", usage: {} }); process.exit(0); }
`;

export interface FakeRun { argv: string[]; cwd: string; stdinNull: boolean; pid: number }

export function codexNode(t: test.TestContext, sessions: Record<string, unknown> = {}, codex: CodexDeps = {}) {
  const node = taskNode(t, { runtimes: ["claude", "codex"], ...sessions });
  // Outside the node directory, so the cleanup below still finds the log.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fake-codex-"));
  const log = path.join(bin, "runs.jsonl");
  const fake = path.join(bin, "codex");
  fs.writeFileSync(fake, SCRIPT(log), { mode: 0o755 });
  const runs = (): FakeRun[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeRun) : []);
  // No fake outlives its test.
  t.after(() => {
    for (const run of runs()) {
      try {
        process.kill(run.pid, "SIGKILL");
      } catch {
        // ended
      }
    }
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const deps = (extra: CodexDeps = {}): RunnerDeps => ({
    ...node.deps(), codex: { findCodex: () => fake, startWaitMs: 5_000, graceMs: 300, ...codex, ...extra },
  });
  return { ...node, fake, runs, deps };
}

// Polls until check is true, for processes that end on their own schedule.
export async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}
