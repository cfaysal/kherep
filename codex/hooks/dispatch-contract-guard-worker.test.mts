// Issue #701. The Codex dispatch guard checks a worker brief like the Claude
// one: a code-bound role (capabilities.json "codeBound") needs well-formed
// revision: and decided: markers, any other dispatch is checked when it declares
// revision:, and a review brief without revision: gets a notice, never a deny.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CODE_BOUND_AGENTS } from "../../claude/hooks/lib/dispatch-policy.mts";
import { fixtureResolution } from "../lib/model-policy.fixture.mts";
import { resolveCapabilities } from "../lib/model-policy.mts";
import { advise, dispatchPolicy, validate } from "./dispatch-contract-guard.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const GUARD = path.join(import.meta.dirname, "dispatch-contract-guard.mts");
const MANIFEST = path.join(REPO, "codex", "parity", "capabilities.json");
const capabilities = resolveCapabilities(JSON.parse(fs.readFileSync(MANIFEST, "utf8")), fixtureResolution());
const POLICY = dispatchPolicy(capabilities);
const OBS_MODEL = POLICY.pins.get("codex-obs") ?? "";
const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const WORKER = `Objective: build it.\nrevision: kherep@${SHA}\ndecided: none`;
const OBS_BRIEF = `- measured: code kherep@${SHA} \`node x.test.mts\` -> 12 pass`;

const dispatch = (message: string, agent_type?: string) =>
  ({ tool_name: "spawn_agent", tool_input: { task_name: "t", message, ...(agent_type ? { agent_type } : {}) } });

test("the manifest marks the same code-bound roles as the Claude policy", () => {
  assert.deepEqual([...POLICY.codeBoundAgents].sort(), [...CODE_BOUND_AGENTS].sort());
});

test("a code-bound role needs both markers, well formed", () => {
  for (const agent of ["kherep-builder", "dc-plugin-build-runner"]) {
    assert.match(validate(dispatch("Build it.", agent), POLICY) ?? "", /^Worker brief format: the brief names no revision:\./, agent);
    assert.match(validate(dispatch(`revision: kherep@${SHA}`, agent), POLICY) ?? "", /the brief names no decided:/, agent);
    assert.match(validate(dispatch(`revision: kherep@HEAD\ndecided: none`, agent), POLICY) ?? "", /revision 1 has a malformed token/, agent);
    assert.match(validate(dispatch(`revision: kherep@${SHA}\ndecided:`, agent), POLICY) ?? "", /decided 1 is empty/, agent);
    assert.equal(validate(dispatch(WORKER, agent), POLICY), null, agent);
    assert.equal(validate(dispatch(`revision: kherep@${SHA}..${SHA}-dirty\ndecided:\n- keep the API`, agent), POLICY), null, agent);
  }
});

test("a code-bound role follows its projected name", () => {
  const renamed = structuredClone(capabilities);
  const builder = renamed.agents["kherep-builder"];
  builder.as = "builder-x";
  (renamed.projectedAgents as Record<string, unknown>)["builder-x"] = (renamed.projectedAgents as Record<string, unknown>)["kherep-builder"];
  const policy = dispatchPolicy(renamed);
  assert.ok(policy.codeBoundAgents.has("builder-x"));
  assert.match(validate(dispatch("Build it.", "builder-x"), policy) ?? "", /Worker brief format/);
});

test("any other dispatch is checked only when it declares revision:", () => {
  assert.equal(validate(dispatch("Look it up."), POLICY), null);
  assert.equal(validate(dispatch("decided:", "personal-agent"), POLICY), null);
  assert.match(validate(dispatch("revision: kherep", "personal-agent"), POLICY) ?? "", /Worker brief format/);
  assert.equal(validate(dispatch(`revision: kherep@${SHA}`), POLICY), null);
});

test("the observation brief keeps its own check", () => {
  const obs = (message: string) => validate({ tool_name: "spawn_agent",
    tool_input: { task_name: "t", agent_type: "codex-obs", model: OBS_MODEL, reasoning_effort: "low", message } }, POLICY);
  assert.equal(obs(`${OBS_BRIEF}\nrevision: kherep`), null, "no worker check on an observation");
  assert.match(obs("Build it.") ?? "", /Observation brief format/);
});

test("advise reports a review brief without revision: and nothing else", () => {
  assert.match(advise(dispatch("Review the guard diff."), POLICY) ?? "", /^Worker brief revision: /);
  assert.match(advise(dispatch("Act as a reviewer.", "personal-agent"), POLICY) ?? "", /^Worker brief revision: /);
  assert.equal(advise(dispatch(`Review it.\nrevision: kherep@${SHA}..${SHA}`), POLICY), null);
  assert.equal(advise(dispatch("Look it up."), POLICY), null);
  assert.equal(advise(dispatch(`${WORKER}\nReview your own diff.`, "kherep-builder"), POLICY), null, "code-bound: no notice");
  assert.equal(advise(dispatch("Review it.\nrevision: kherep"), POLICY), null, "a deny reports nothing");
});

function installed(t: { after: (fn: () => void) => void }, libs: string[], edit: (lib: string, text: string) => string = (_, text) => text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-dispatch-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookDir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hookDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks", "parity"));
  const guard = path.join(hookDir, "codex-dispatch-contract-guard.mts");
  fs.copyFileSync(GUARD, guard);
  for (const lib of libs) fs.writeFileSync(path.join(hookDir, "lib", lib), edit(lib, fs.readFileSync(path.join(REPO, "claude", "hooks", "lib", lib), "utf8")));
  fs.writeFileSync(path.join(root, "hooks", "parity", "capabilities.json"), JSON.stringify(capabilities));
  return (message: string, agent_type?: string) =>
    spawnSync(process.execPath, [guard], { encoding: "utf8", input: JSON.stringify(dispatch(message, agent_type)) }).stdout;
}

function decision(stdout: string): { deny?: string; notice?: string } {
  if (!stdout) return {};
  const output = JSON.parse(stdout) as { hookSpecificOutput: Record<string, string>; systemMessage?: string };
  const hso = output.hookSpecificOutput;
  return hso.permissionDecision === "deny" ? { deny: hso.permissionDecisionReason } : { notice: hso.additionalContext };
}

test("the installed guard denies, reports and stays silent through its lib sibling", (t) => {
  const run = installed(t, ["obs-brief-policy.mts", "worker-brief-policy.mts"]);
  assert.match(decision(run("Build it.", "kherep-builder")).deny ?? "", /^Worker brief format/);
  assert.equal(run(WORKER, "kherep-builder"), "");
  assert.match(decision(run("Review the guard diff.")).notice ?? "", /^Worker brief revision: /);
  assert.equal(run("Look it up."), "");
});

test("a missing worker lib fails closed for a code-bound dispatch only", (t) => {
  const run = installed(t, ["obs-brief-policy.mts"]);
  assert.match(decision(run(WORKER, "kherep-builder")).deny ?? "", /failed unexpectedly/);
  assert.equal(run("Review it.\nrevision: kherep"), "", "not code-bound: neither checked nor reported");
  assert.equal(run("Review the guard diff."), "");
});

test("an installed lib that predates workerBriefNotice reports nothing and keeps its denies", (t) => {
  const run = installed(t, ["obs-brief-policy.mts", "worker-brief-policy.mts"], (lib, text) => lib !== "worker-brief-policy.mts" ? text
    : text.replace(/export function workerBriefNotice[\s\S]*$/, ""));
  assert.equal(run("Review the guard diff."), "", "no notice");
  assert.match(decision(run("Build it.", "kherep-builder")).deny ?? "", /^Worker brief format/);
  assert.match(decision(run("revision: kherep", "personal-agent")).deny ?? "", /^Worker brief format/);
  assert.equal(run(WORKER, "kherep-builder"), "");
});
