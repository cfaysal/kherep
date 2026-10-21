// Issue #504. The dispatcher journals each guarded call of a delegated run (a payload with a valid
// agent_id) after its guards, and capture never changes the decision: a journal lib that is missing,
// empty, throws or hangs, and a filesystem that fails or stalls, leave the decision JSON byte for
// byte as without capture, within the journal cap plus the marker grace. The renderer then reads
// unknown, never none, wherever a line was lost; a lost line with no marker is the named residual.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { denialFaultEnv, type DenialFault } from "./denial-fault.fixture.mts";
import { dispatcherFixture, type DispatcherFixture } from "./guard-dispatch-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";
import { readJournal, renderReport } from "./lib/denial-report.mts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const LIBS = ["denial-journal.mts", "workspace-scope.mts"];
const decision = (permissionDecision: string, reason: string): string => JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } });
const GUARDS: Record<string, string> = {
  "exit2.mts": "process.stderr.write(\"[exit2-guard] exit2 says no\\nsecond line\\n\");\nprocess.exit(2);\n",
  "json-deny.mts": `process.stdout.write(${JSON.stringify(decision("deny", "[json-guard] json says no"))});\n`,
  "allow.mts": "process.exit(0);\n",
  "empty.mts": "",
};

// A dispatcher copy with synthetic guards; lib is the journal lib's state in it.
function fixture(lib: "present" | "missing" | "empty" | "throwing" | "hanging" = "present"): DispatcherFixture {
  const fx = dispatcherFixture("guard-dispatch-denials-");
  roots.push(fx.root);
  for (const [name, source] of Object.entries(GUARDS)) fs.writeFileSync(path.join(fx.hooks, name), source);
  if (lib !== "missing") for (const name of LIBS) fs.copyFileSync(path.join(import.meta.dirname, "lib", name), path.join(fx.hooks, "lib", name));
  const target = path.join(fx.hooks, "lib", "denial-journal.mts");
  if (lib === "empty") fs.writeFileSync(target, "");
  if (lib === "throwing") fs.writeFileSync(target, "export function journalVerdict() { throw new Error(\"boom\"); }\n");
  if (lib === "hanging") fs.writeFileSync(target, "export function journalVerdict() { return new Promise(() => {}); }\n");
  return fx;
}

const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command: "git push origin" }, cwd: "/w", agent_id: "agent-t1", agent_type: "general-purpose", tool_use_id: "toolu_1", ...extra });

interface Run { status: number | null; stdout: string; ms: number }
function dispatch(fx: DispatcherFixture, guards: string[], input: string, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fx.dispatch, ...guards.map((g) => path.join(fx.hooks, g))],
      { windowsHide: true, env });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, ms: Date.now() - start }));
    child.stdin.end(input);
  });
}
const lines = (fx: DispatcherFixture): Record<string, unknown>[] => {
  const file = journalPaths(fx.root, "agent-t1").journal;
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};
const firstLine = (fx: DispatcherFixture): string => renderReport(readJournal(fx.root, "agent-t1")).text.split("\n")[0]!;

test("a delegated call is journalled with one denial per denying guard; the decision is the one without capture", async () => {
  const fx = fixture();
  const plain = await dispatch(fx, ["exit2.mts", "json-deny.mts", "allow.mts", "empty.mts"], payload({ agent_id: undefined }));
  assert.equal(fs.existsSync(journalPaths(fx.root, "x").dir), false, "no agent_id, no journal");
  const run = await dispatch(fx, ["exit2.mts", "json-deny.mts", "allow.mts", "empty.mts"], payload());
  assert.equal(run.status, 0);
  assert.equal(run.stdout, plain.stdout);
  const [line] = lines(fx);
  assert.equal(line!.kind, "call");
  assert.equal(line!.id, "toolu_1");
  assert.equal(line!.agent_type, "general-purpose");
  assert.equal(line!.decision, "deny");
  assert.deepEqual(line!.denials, [
    { guard: "exit2-guard", target: "git", reason: "[exit2-guard] exit2 says no", broken: false },
    { guard: "json-guard", target: "git", reason: "[json-guard] json says no", broken: false },
    { guard: "guard-dispatch", target: "git", reason: "[guard-dispatch] empty.mts cannot run (empty, 0 bytes); the tool call is blocked until hook integrity restores it", broken: true },
  ]);
  assert.equal(firstLine(fx), "DENIED-CALLS: 3");
});

test("an allow is a call line without denials, the handback is not journalled, a non-string tool_use_id is null", async () => {
  const fx = fixture();
  await dispatch(fx, ["allow.mts"], payload());
  await dispatch(fx, ["exit2.mts"], payload({ tool_name: "SubagentHandback", tool_input: { message: "report" } }));
  await dispatch(fx, ["allow.mts"], payload({ tool_use_id: 42, agent_id: "agent-t1" }));
  assert.deepEqual(lines(fx).map((line) => [line.decision, line.id, (line.denials as unknown[]).length]), [["none", "toolu_1", 0], ["none", null, 0]]);
  assert.equal(firstLine(fx), "DENIED-CALLS: none");
  await dispatch(fx, ["exit2.mts"], payload({ agent_id: "../../escape" }));
  assert.deepEqual(fs.readdirSync(journalPaths(fx.root, "x").dir), ["agent-t1.jsonl"]);
});

for (const lib of ["missing", "empty", "throwing", "hanging"] as const) {
  test(`a journal lib that is ${lib}: identical decision, exit 0, a marker, never the internal-error deny`, async () => {
    const reference = await dispatch(fixture(), ["exit2.mts"], payload());
    const fx = fixture(lib);
    const run = await dispatch(fx, ["exit2.mts"], payload());
    assert.equal(run.status, 0);
    assert.equal(run.stdout, reference.stdout);
    assert.doesNotMatch(run.stdout, /internal error|cannot run/);
    assert.equal(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), lib === "hanging" ? "lib-timeout\n" : "lib-load\n");
    assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
    assert.ok(run.ms < 8_000, `${run.ms} ms`);
  });
}

async function faulted(fault: DenialFault): Promise<{ fx: DispatcherFixture; run: Run; reference: Run }> {
  const fx = fixture();
  await dispatch(fx, ["allow.mts"], payload({ tool_use_id: "toolu_0" })); // an earlier, journalled call
  const reference = await dispatch(fixture(), ["exit2.mts"], payload());
  const run = await dispatch(fx, ["exit2.mts"], payload(), denialFaultEnv(fault, "guard-dispatch.mts"));
  assert.equal(run.status, 0);
  assert.equal(run.stdout, reference.stdout, "the decision is unchanged");
  return { fx, run, reference };
}

test("ENOSPC on the denying call: a marker, the renderer reads unknown (capture-failed)", async () => {
  const { fx } = await faulted("journal-enospc");
  assert.equal(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), "append\n");
  assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
});

test("no space for the marker either: the journal is renamed to the marker", async () => {
  const { fx } = await faulted("enospc-all");
  assert.equal(fs.existsSync(journalPaths(fx.root, "agent-t1").journal), false);
  assert.match(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), /"id":"toolu_0"/);
  assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
});

test("append and rename both fail: the decision still stands; the lost line is the named residual", async () => {
  const { fx } = await faulted("all-fail");
  assert.equal(fs.existsSync(journalPaths(fx.root, "agent-t1").marker), false);
  assert.equal(lines(fx).length, 1, "only the earlier call; docs name this residual");
});

for (const fault of ["journal-hang", "all-hang"] as const) {
  test(`a writer that never settles (${fault}): the decision within cap and grace, no broken guard, no re-check`, async () => {
    const { run, reference } = await faulted(fault);
    assert.ok(run.ms < reference.ms + 1_900 + 1_500, `${run.ms} ms against ${reference.ms} ms`);
    assert.doesNotMatch(run.stdout, /additionalContext|cannot run/);
  });
}
