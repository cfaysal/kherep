// Issue #507, part 1. guard-dispatch.mts runs the PreToolUse guards of one
// matcher group and turns every way a guard can fail to run into a deny that
// names the file. The fixture copies the dispatcher into a temporary hooks/
// directory next to synthetic guards, so no repository guard is involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

// Real path: macOS tmpdir is a symlink, and Node names the main module by its real path.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-dispatch-")));
const HOOKS = path.join(ROOT, "hooks");
const DISPATCH = path.join(HOOKS, "guard-dispatch.mts");
const TRACE = path.join(ROOT, "trace.txt");
fs.mkdirSync(HOOKS);
fs.copyFileSync(path.join(import.meta.dirname, "guard-dispatch.mts"), DISPATCH);
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const decision = (permissionDecision: string, reason: string): string => JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
});
const printing = (output: unknown): string => `process.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`;
const notice = (additionalContext: string, extra: Record<string, unknown> = {}): string =>
  printing({ hookSpecificOutput: { hookEventName: "PreToolUse", ...extra, additionalContext } });
const traced = (name: string, body: string): string =>
  `import fs from "node:fs";\nfs.readFileSync(0);\nfs.appendFileSync(${JSON.stringify(TRACE)}, "${name}\\n");\n${body}\n`;

const GUARDS: Record<string, string> = {
  "allow.mts": traced("allow", "process.exit(0);"),
  "allow-b.mts": traced("allow-b", "process.exit(0);"),
  "empty.mts": "",
  "syntax.mts": "export const x = ;\n",
  "exit1.mts": "process.exit(1);\n",
  "signal.mts": "process.kill(process.pid, \"SIGKILL\");\nsetInterval(() => {}, 1000);\n",
  "hang.mts": "setInterval(() => {}, 1000);\n",
  "garbage.mts": "process.stdout.write(\"not json\");\n",
  "unsupported.mts": `process.stdout.write(${JSON.stringify(JSON.stringify({ decision: "block", reason: "x" }))});\n`,
  "exit2.mts": traced("exit2", "process.stderr.write(\"exit2 says no\\n\");\nprocess.exit(2);"),
  "exit2-silent.mts": "process.exit(2);\n",
  "json-deny.mts": traced("json-deny", `process.stdout.write(${JSON.stringify(decision("deny", "json says no"))});`),
  "json-ask.mts": `process.stdout.write(${JSON.stringify(decision("ask", "please confirm"))});\n`,
  "json-allow.mts": `process.stdout.write(${JSON.stringify(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }))});\n`,
  "noisy.mts": "process.stderr.write(\"noisy diagnostic\\n\");\n",
  "notice.mts": notice("notice one"),
  "notice-b.mts": notice("notice two"),
  "ask-notice.mts": notice("ask context", { permissionDecision: "ask", permissionDecisionReason: "ask reason" }),
  "updated-input.mts": printing({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { command: "true" } } }),
  "system-message.mts": printing({ systemMessage: "hi",
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }),
  "neither.mts": printing({ hookSpecificOutput: { hookEventName: "PreToolUse" } }),
};
for (const [name, source] of Object.entries(GUARDS)) fs.writeFileSync(path.join(HOOKS, name), source);
fs.mkdirSync(path.join(HOOKS, "a-directory.mts"));
const OUTSIDE = path.join(ROOT, "outside.mts");
fs.writeFileSync(OUTSIDE, "process.exit(0);\n");
// A guard under hooks/ that is a symlink to OUTSIDE; not every Windows runner may link.
const LINKED = path.join(HOOKS, "linked.mts");
let linkError = "";
try { fs.symlinkSync(OUTSIDE, LINKED, "file"); } catch (error) { linkError = String(error); }

const guard = (name: string): string => path.join(HOOKS, name);
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });

interface Run { status: number | null; stdout: string; stderr: string; ms: number }

function dispatch(guards: string[], input: string = PAYLOAD): Promise<Run> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DISPATCH, ...guards],
      { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - start }));
    child.stdin.end(input);
  });
}

// The one JSON document a non-allow run prints.
interface Printed { permissionDecision?: string; permissionDecisionReason: string; additionalContext?: string }
function verdict(run: Run): Printed {
  assert.equal(run.status, 0, `dispatcher exit ${run.status}; stderr ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: Printed & { hookEventName: string } };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  return parsed.hookSpecificOutput;
}

function assertFailureDeny(run: Run, file: string): void {
  const result = verdict(run);
  assert.equal(result.permissionDecision, "deny", run.stdout);
  assert.ok(result.permissionDecisionReason.includes(`[guard-dispatch] ${file} cannot run (`), result.permissionDecisionReason);
  assert.ok(result.permissionDecisionReason.includes("the tool call is blocked until hook integrity restores it"));
}

describe("a guard that cannot run denies the tool call and names its file", { concurrency: true }, () => {
  const cases: [string, string][] = [
    ["an empty guard", "empty.mts"],
    ["a missing guard", "missing.mts"],
    ["a guard that is not a regular file", "a-directory.mts"],
    ["a syntax-broken guard", "syntax.mts"],
    ["a guard that exits 1", "exit1.mts"],
    ["a guard killed by a signal", "signal.mts"],
    ["a guard with malformed stdout", "garbage.mts"],
    ["a guard with JSON that is no PreToolUse decision", "unsupported.mts"],
  ];
  for (const [label, name] of cases) {
    test(label, async () => {
      assertFailureDeny(await dispatch([guard("allow.mts"), guard(name)]), guard(name));
    });
  }

  test("a guard that runs past the 10 s limit", async () => {
    const run = await dispatch([guard("hang.mts")]);
    assertFailureDeny(run, guard("hang.mts"));
    assert.match(verdict(run).permissionDecisionReason, /timed out after 10 s/);
    assert.ok(run.ms < 20_000, `took ${run.ms} ms`);
  });

  test("a guard outside the dispatcher's directory", async () => {
    const run = await dispatch([OUTSIDE]);
    assertFailureDeny(run, OUTSIDE);
    assert.match(verdict(run).permissionDecisionReason, /outside /);
  });

  test("a guard under hooks/ that is a symlink to a file outside it", async (t) => {
    if (linkError) return t.skip(`cannot create a file symlink: ${linkError}`);
    const run = await dispatch([guard("allow.mts"), LINKED]);
    assertFailureDeny(run, LINKED);
    assert.match(verdict(run).permissionDecisionReason, /outside /);
  });

  test("malformed stdin", async () => {
    for (const input of ["{not json", "", "null", "[1]"]) {
      assertFailureDeny(await dispatch([guard("allow.mts")], input), DISPATCH);
    }
  });

  test("no guard argument at all", async () => {
    assertFailureDeny(await dispatch([]), DISPATCH);
  });

  test("the dispatcher named as its own guard", async () => {
    assertFailureDeny(await dispatch([DISPATCH]), DISPATCH);
  });

  for (const [label, name, why] of [
    ["a field the dispatcher would drop", "updated-input.mts", "(unsupported field updatedInput)"],
    ["a top-level field besides hookSpecificOutput", "system-message.mts", "(unsupported field systemMessage)"],
    ["neither a decision nor a notice", "neither.mts", "(stdout is not a PreToolUse decision)"],
  ]) {
    test(`a guard printing ${label}`, async () => {
      const run = await dispatch([guard("allow.mts"), guard(name)]);
      assertFailureDeny(run, guard(name));
      assert.ok(verdict(run).permissionDecisionReason.includes(why), verdict(run).permissionDecisionReason);
    });
  }
});

describe("working guards keep their verdicts", () => {
  test("exit 2 is a deny carrying the guard's stderr", async () => {
    const result = verdict(await dispatch([guard("exit2.mts")]));
    assert.equal(result.permissionDecision, "deny");
    assert.equal(result.permissionDecisionReason, "exit2 says no");
  });

  test("exit 2 without stderr names the file", async () => {
    const result = verdict(await dispatch([guard("exit2-silent.mts")]));
    assert.equal(result.permissionDecisionReason,
      `${guard("exit2-silent.mts")} blocked this tool call without giving a reason`);
  });

  test("a JSON deny passes through", async () => {
    const result = verdict(await dispatch([guard("allow.mts"), guard("json-deny.mts")]));
    assert.deepEqual(result, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "json says no" });
  });

  test("a printed allow passes through, also without a reason", async () => {
    const result = verdict(await dispatch([guard("allow.mts"), guard("json-allow.mts")]));
    assert.deepEqual(result, { hookEventName: "PreToolUse", permissionDecision: "allow" });
  });

  test("ask and allow combine to ask", async () => {
    const result = verdict(await dispatch([guard("allow.mts"), guard("json-ask.mts")]));
    assert.equal(result.permissionDecision, "ask");
    assert.equal(result.permissionDecisionReason, "please confirm");
  });

  test("deny wins over ask, and every guard still runs after a deny", async () => {
    fs.rmSync(TRACE, { force: true });
    const run = await dispatch([guard("exit2.mts"), guard("json-ask.mts"), guard("json-deny.mts"), guard("allow.mts"),
      guard("allow-b.mts")]);
    const result = verdict(run);
    assert.equal(result.permissionDecision, "deny");
    assert.equal(result.permissionDecisionReason, "exit2 says no\njson says no");
    assert.deepEqual(fs.readFileSync(TRACE, "utf8").trim().split(/\r?\n/).sort(),
      ["allow", "allow-b", "exit2", "json-deny"]);
  });

  test("a guard's stderr is forwarded", async () => {
    const run = await dispatch([guard("noisy.mts"), guard("allow.mts")]);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /noisy diagnostic/);
  });

  test("a notice alone passes through without a decision", async () => {
    const result = verdict(await dispatch([guard("notice.mts")]));
    assert.deepEqual(result, { hookEventName: "PreToolUse", additionalContext: "notice one" });
  });

  test("a notice next to a plain allow prints only the notice, no decision", async () => {
    for (const order of [["allow.mts", "notice.mts"], ["notice.mts", "allow.mts", "allow-b.mts"]]) {
      const result = verdict(await dispatch(order.map(guard)));
      assert.equal(result.permissionDecision, undefined, JSON.stringify(result));
      assert.deepEqual(result, { hookEventName: "PreToolUse", additionalContext: "notice one" });
    }
  });

  test("a notice next to a JSON deny keeps both", async () => {
    const result = verdict(await dispatch([guard("notice.mts"), guard("json-deny.mts")]));
    assert.deepEqual(result, { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "json says no", additionalContext: "notice one" });
  });

  test("two notices join in argument order", async () => {
    const result = verdict(await dispatch([guard("notice-b.mts"), guard("notice.mts")]));
    assert.deepEqual(result, { hookEventName: "PreToolUse", additionalContext: "notice two\nnotice one" });
  });

  test("a decision with additionalContext keeps both", async () => {
    const result = verdict(await dispatch([guard("ask-notice.mts")]));
    assert.deepEqual(result, { hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: "ask reason", additionalContext: "ask context" });
  });

  test("all allow prints nothing", async () => {
    const run = await dispatch([guard("allow.mts"), guard("allow-b.mts")]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
  });
});
