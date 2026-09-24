import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { observationPrompt } from "./observation-stop.mts";

async function decision(input: unknown, env: NodeJS.ProcessEnv = {}) {
  const hook = await import("./observation-stop.mts").catch(() => null);
  assert.ok(hook, "Codex Mac observation Stop hook must exist");
  return hook.decision(input, env);
}

const workspace = "/synthetic/kherep";
const env = { KHEREP_WORKSPACE: workspace };
const firstStop = { turn_id: "synthetic-turn", stop_hook_active: false, cwd: workspace };

test("first Stop requests one pinned codex-obs dispatch without copying turn text", async () => {
  const result = await decision({ ...firstStop, last_assistant_message: "Synthetic private sentinel" }, env);
  assert.equal(result?.decision, "block");
  assert.match(result.reason, /codex-obs/);
  assert.match(result.reason, /gpt-5\.6-luna/);
  assert.match(result.reason, /low/);
  assert.match(result.reason, /empty result/i);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private sentinel/);
});

test("repeated Stop cannot request the observation agent again", async () => {
  assert.equal(await decision({ ...firstStop, stop_hook_active: true }, env), null);
});

test("missing Stop markers never request observation continuation", async () => {
  assert.equal(await decision({ ...firstStop, turn_id: "" }, env), null);
  assert.equal(await decision({ ...firstStop, stop_hook_active: undefined }, env), null);
  assert.equal(await decision({}, env), null);
});

test("acceptance requirement survives first and repeated Stop events", async () => {
  const input = { ...firstStop, last_assistant_message: "Work done." };
  const first = await decision(input, env);
  assert.equal(first?.decision, "block");
  assert.match(first.reason, /C1-C4/);
  assert.match(first.reason, /codex-obs/);
  const repeated = await decision({ ...input, stop_hook_active: true }, env);
  assert.equal(repeated?.decision, "block");
  assert.match(repeated.reason, /C1-C4/);
  assert.doesNotMatch(repeated.reason, /codex-obs/);
  assert.equal(await decision({ ...input, last_assistant_message: "C1 C2 C3 C4", stop_hook_active: true }, env), null);
});

test("observation broker path is literal on macOS and Windows shells", () => {
  const macWorkspace = "/tmp/space's $(printf expanded)";
  const macBroker = path.posix.join(macWorkspace, "tools", "atl-confluence.mts");
  assert.ok(observationPrompt(macWorkspace, "darwin").includes(
    `node '${macBroker.replaceAll("'", "'\\''")}'`,
  ));

  const winWorkspace = "C:\\temp\\space's $(throw expanded)";
  const winBroker = path.win32.join(winWorkspace, "tools", "atl-confluence.mts");
  assert.ok(observationPrompt(winWorkspace, "win32").includes(
    `node '${winBroker.replaceAll("'", "''")}'`,
  ));
});
