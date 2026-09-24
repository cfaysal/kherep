#!/usr/bin/env node
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");

const hooks = [
  { file: "maestro-discipline.js", marker: "MAESTRO TURN CHECK" },
  { file: "orchestra-default.js", marker: "KHEREP ORCHESTRA ACTIVE" },
];
let pass = 0;
let fail = 0;

function invoke(file, payload, envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  if (!Object.hasOwn(envExtra, "KHEREP_WORKSPACE")) delete env.KHEREP_WORKSPACE;
  return spawnSync("node", [path.join(__dirname, file)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
}

function check(name, condition) {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"} | ${name}`);
}

for (const hook of hooks) {
  const win = invoke(hook.file, {
    cwd: "C:\\Users\\ExampleUser\\Kherep\\project",
    transcript_path: "C:/tmp/no-special-slug/session.jsonl",
  }, { USERPROFILE: "C:\\Users\\ExampleUser", HOME: "" });
  check(`${hook.file}: Windows cwd`, win.status === 0 && win.stdout.includes(hook.marker));

  const mac = invoke(hook.file, {
    cwd: "/Users/example/Kherep/project",
    transcript_path: "/tmp/no-special-slug/session.jsonl",
  }, { USERPROFILE: "", HOME: "/Users/example" });
  check(`${hook.file}: macOS cwd`, mac.status === 0 && mac.stdout.includes(hook.marker));

  const configured = invoke(
    hook.file,
    { transcript_path: "/tmp/no-special-slug/session.jsonl" },
    { KHEREP_WORKSPACE: "/Users/example/Work" }
  );
  check(`${hook.file}: explicit workspace`, configured.status === 0 && configured.stdout.includes(hook.marker));

  const slugOnly = invoke(hook.file, { transcript_path: "C:/tmp/d--work/session.jsonl" });
  check(`${hook.file}: slug alone silent`, slugOnly.status === 0 && slugOnly.stdout === "");

  const other = invoke(hook.file, {
    cwd: "/Users/example/unrelated-project",
    transcript_path: "C:/tmp/d--work/session.jsonl",
  });
  check(`${hook.file}: unrelated cwd silent`, other.status === 0 && other.stdout === "");

  const malformed = invoke(hook.file, "not-json");
  check(`${hook.file}: malformed input silent`, malformed.status === 0 && malformed.stdout === "");
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
