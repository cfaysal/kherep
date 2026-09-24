#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const hook = path.join(__dirname, "runtime-capability-snapshot.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-snapshot-"));
const claudeHome = path.join(root, ".claude");
fs.mkdirSync(path.join(claudeHome, "plugins"), { recursive: true });

fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({
  enabledPlugins: { "good@market": true, "missing@market": true },
}));
fs.writeFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), JSON.stringify({
  plugins: {
    "good@market": [{ version: "2.0.0", lastUpdated: "2026-01-02" }],
    "disabled@market": [{ version: "1.0.0", lastUpdated: "2026-01-01" }],
  },
}));
fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({
  mcpServers: { forge: { command: "secret-command", env: { TOKEN: "DO_NOT_LEAK" } } },
  projects: { demo: { mcpServers: { rovo: { url: "https://secret.example" } } } },
}));
fs.mkdirSync(path.join(claudeHome, "kherep", "local-inference"), { recursive: true });
fs.writeFileSync(path.join(claudeHome, "kherep", "local-inference", "config.json"), JSON.stringify({
  backends: {
    win: { engine: "configured-engine", endpoint: "http://localhost:9000/v1", model: "fixture-model" },
    mac: { engine: "configured-engine", endpoint: "http://localhost:9001/v1" },
  },
}));

function run(payload, envExtra = {}) {
  return spawnSync("node", [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      USERPROFILE: root,
      HOME: root,
      CLAUDE_HOME: claudeHome,
      KHEREP_WORKSPACE: "",
      ...envExtra,
    },
  });
}

let pass = 0;
let fail = 0;
function check(name, condition) {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"} | ${name}`);
}

const scoped = run({
  transcript_path: "C:/tmp/unrelated-transcript-name/session.jsonl",
  cwd: "D:\\Work\\kherep",
}, { KHEREP_WORKSPACE: "D:\\Work" });
let context = "";
try {
  context = JSON.parse(scoped.stdout).hookSpecificOutput.additionalContext;
} catch {}
check("hook exits zero", scoped.status === 0);
check("installed version reported", context.includes("good@market@2.0.0"));
check("enabled missing reported", context.includes("missing@market"));
check("installed disabled reported", context.includes("disabled@market"));
check("configured MCP names reported", context.includes("forge") && context.includes("rovo"));
check("local backend contract reported", context.includes("win=configured-engine@http://localhost:9000/v1#fixture-model"));
check("workspace evidence is explicit", context.includes("Workspace: cwd="));
check("MCP health is not claimed", context.includes("NOT a health claim"));
check("secret command omitted", !context.includes("secret-command"));
check("secret token omitted", !context.includes("DO_NOT_LEAK"));
check("secret URL omitted", !context.includes("secret.example"));

const mac = run({
  transcript_path: "/Users/example/.claude/projects/-Users-example-Work/session.jsonl",
  cwd: "/Users/example/Work/kherep",
}, { KHEREP_WORKSPACE: "/Users/example/Work" });
check("POSIX Kherep cwd is scoped", mac.status === 0 && mac.stdout.includes("LIVE CAPABILITY SNAPSHOT"));

const configured = run(
  { transcript_path: "C:/tmp/no-host-slug/session.jsonl" },
  { KHEREP_WORKSPACE: "D:\\Work" }
);
check("KHEREP_WORKSPACE scopes cwd-less legacy payload", configured.status === 0 && configured.stdout.includes("LIVE CAPABILITY SNAPSHOT"));

const other = run({
  transcript_path: "C:/tmp/d--work/session.jsonl",
  cwd: "D:\\unrelated-project",
});
check("out-of-scope session silent", other.status === 0 && other.stdout === "");

const slugOnly = run({ transcript_path: "C:/tmp/d--work/session.jsonl" });
check("Windows transcript slug alone is not scope", slugOnly.status === 0 && slugOnly.stdout === "");

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {}
console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
