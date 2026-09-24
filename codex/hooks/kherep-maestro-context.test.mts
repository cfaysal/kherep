import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";


const hook = path.join(import.meta.dirname, "kherep-maestro-context.mts");

function run(input: unknown, env: NodeJS.ProcessEnv = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, KHEREP_WORKSPACE: "", ...env };
  if (!Object.hasOwn(env, "KHEREP_WORKSPACE")) delete childEnv.KHEREP_WORKSPACE;
  return spawnSync(process.execPath, [hook], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: childEnv,
  });
}

{
  const result = run({
    hook_event_name: "SessionStart",
    cwd: "D:\\Work\\ForgeApps\\Alchemist-for-Jira",
  }, { KHEREP_WORKSPACE: "D:\\Work" });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
  assert.match(result.stdout, /\[Maestro on \| routing loaded \| evidence-first\]/);
  assert.match(result.stdout, /ROUTING\.md/);
}

{
  const result = run({
    hook_event_name: "UserPromptSubmit",
    cwd: "/Users/example/Kherep/ForgeApps/Aegis-Pro",
  }, { KHEREP_WORKSPACE: "/Users/example/Kherep" });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /MAESTRO TURN CHECK/);
  assert.match(result.stdout, /C1 correctness/);
  assert.match(result.stdout, /Never overlap writes/i);
  assert.match(result.stdout, /dispatch codex-obs once.*gpt-5\.6-luna.*fork_turns none/);
  assert.match(result.stdout, /observationPublishingAuthorized is literal true/);
  assert.doesNotMatch(result.stdout, /Before the final response, dispatch the codex-obs agent/);
}

{
  const result = run({
    hook_event_name: "SessionStart",
    cwd: "C:\\unrelated\\project",
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
}

{
  const result = run(
    { hook_event_name: "SessionStart", cwd: "C:\\work\\private-repos\\app" },
    { KHEREP_WORKSPACE: "C:\\work\\private-repos" },
  );
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
}

{
  const result = run(
    { hook_event_name: "SessionStart", cwd: "/Users/example/Kherep/project" },
    { HOME: "/Users/example", USERPROFILE: "" },
  );
  assert.match(result.stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
}

{
  const result = run(
    { hook_event_name: "SessionStart", cwd: "/work/worker/project" },
    { HOME: "/Users/example", KHEREP_WORKSPACE: "/Users/example/Kherep" },
  );
  assert.strictEqual(result.stdout, "");
}

{
  const result = run("not json");
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
}

process.stdout.write("kherep-maestro-context: ok\n");
