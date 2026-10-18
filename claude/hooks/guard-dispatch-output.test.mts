// Issue #507, part 1, review. What a guard prints reaches the verdict as the
// guard meant it, or the call is denied: an output field the dispatcher does not
// accept is named, also when its name is empty, and a reason needs a decision.
// A guard's own warnings are not hidden. Same fixture idea as
// guard-dispatch.test.mts: the dispatcher copied next to synthetic guards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { dispatcherFixture } from "./guard-dispatch-fixture.mts";

const { root: ROOT, hooks: HOOKS, dispatch: DISPATCH } = dispatcherFixture("guard-dispatch-output-");
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const pre = (fields: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
const printing = (output: unknown): string => `process.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`;
const warning = (text: string): string => `process.emitWarning(${JSON.stringify(text)}, "ExperimentalWarning");\n`;
const STRIP = "Type Stripping is an experimental feature and might change at any time";
const GUARDS: Record<string, string> = {
  "empty-top.mts": printing({ "": 0, ...pre({ permissionDecision: "allow", updatedInput: { command: "true" } }) }),
  "empty-inner.mts": printing(pre({ permissionDecision: "allow", "": 0 })),
  "bad-decision.mts": printing(pre({ permissionDecision: "block" })),
  "bad-reason.mts": printing(pre({ permissionDecision: "deny", permissionDecisionReason: 5 })),
  "bad-context.mts": printing(pre({ additionalContext: "" })),
  "reason-only.mts": printing(pre({ permissionDecisionReason: "why", additionalContext: "note" })),
  "warn-exit2.mts": `${warning("synthetic guard reason")}process.exitCode = 2;\n`,
  "warn-exit0.mts": `${warning("synthetic guard reason")}process.exitCode = 0;\n`,
  "strip-warning.mts": `${warning(STRIP)}process.stderr.write("own reason\\n");\nprocess.exitCode = 2;\n`,
};
for (const [name, source] of Object.entries(GUARDS)) fs.writeFileSync(path.join(HOOKS, name), source);

interface Printed { permissionDecision?: string; permissionDecisionReason?: string }

function dispatch(name: string): { stdout: string; stderr: string; output?: Printed } {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", DISPATCH, path.join(HOOKS, name)], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }),
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(run.status, 0, `dispatcher exit ${run.status}; stderr ${run.stderr}`);
  const output = run.stdout ? (JSON.parse(run.stdout) as { hookSpecificOutput: Printed }).hookSpecificOutput : undefined;
  return { stdout: run.stdout, stderr: run.stderr, output };
}

for (const [name, why] of [
  ["empty-top.mts", '(unsupported field "")'],
  ["empty-inner.mts", '(unsupported field "")'],
  ["bad-decision.mts", "(invalid field permissionDecision)"],
  ["bad-reason.mts", "(invalid field permissionDecisionReason)"],
  ["bad-context.mts", "(invalid field additionalContext)"],
  ["reason-only.mts", "(invalid field permissionDecisionReason)"],
]) {
  test(`${name} denies the call and names the field ${why}`, () => {
    const { output } = dispatch(name);
    assert.equal(output?.permissionDecision, "deny", JSON.stringify(output));
    assert.ok(String(output?.permissionDecisionReason)
      .includes(`${path.join(HOOKS, name)} cannot run (stdout is not a PreToolUse decision ${why})`), JSON.stringify(output));
  });
}

test("a guard's own warning with exit 2 is the deny reason, as when the guard runs directly", () => {
  const direct = spawnSync(process.execPath, [path.join(HOOKS, "warn-exit2.mts")], { input: "{}", encoding: "utf8" });
  assert.equal(direct.status, 2);
  assert.match(direct.stderr, /ExperimentalWarning: synthetic guard reason/);
  const { output } = dispatch("warn-exit2.mts");
  assert.equal(output?.permissionDecision, "deny");
  assert.match(String(output?.permissionDecisionReason), /ExperimentalWarning: synthetic guard reason/);
});

test("a guard's own warning on exit 0 is forwarded to stderr", () => {
  const run = dispatch("warn-exit0.mts");
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /ExperimentalWarning: synthetic guard reason/);
});

test("only the type-stripping warning is dropped from a guard's stderr", () => {
  const { output } = dispatch("strip-warning.mts");
  assert.equal(output?.permissionDecision, "deny");
  assert.equal(output?.permissionDecisionReason, "own reason");
});

// The dispatcher ends itself after its output (part 2): it must wait until both
// streams took every byte, also when it prints no verdict.
const MIB = 1024 * 1024;
fs.writeFileSync(path.join(HOOKS, "mib-stderr.mts"), `process.stderr.write("x".repeat(${MIB}));\n`);
fs.writeFileSync(path.join(HOOKS, "mib-stderr-deny.mts"), `process.stderr.write("y".repeat(${MIB}));\n`
  + printing(pre({ permissionDecision: "deny", permissionDecisionReason: "large deny" })));

for (const [name, letter, decision] of [["mib-stderr.mts", "x", undefined], ["mib-stderr-deny.mts", "y", "deny"]] as const) {
  test(`${name}: every byte of 1 MiB guard stderr arrives${decision ? " next to the deny" : ""}`, () => {
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", DISPATCH, path.join(HOOKS, name)], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }),
      encoding: "utf8", windowsHide: true, maxBuffer: 8 * MIB, timeout: 20_000,
    });
    assert.equal(run.status, 0, String(run.error));
    assert.equal(run.stderr.split(letter).length - 1, MIB);
    if (!decision) return assert.equal(run.stdout, "");
    assert.deepEqual(JSON.parse(run.stdout).hookSpecificOutput,
      { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "large deny" });
  });
}
