import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { substituteTemplatePaths } from "./render-profile-paths.mts";
import { filterMacPermissions, filterManagedDisallowedPermissions, mergeHooks, normalizeHookCommand } from "./render-profile-settings.mts";
import { renderLocalInference, renderSettings } from "./render-profile.mts";

const workspace = "/Users/example/Kherep";
const credentials = "/Users/example/.kherep/credentials";
const claudeHome = "/Users/example/.claude";

test("substitutes neutral source placeholders recursively on every host", () => {
  const value = {
    allow: [
      "Read(__KHEREP_CREDENTIALS_ROOT__/**)",
      "Bash(find __KHEREP_WORKSPACE__/apps -type f \\(-name *.js\\))",
      "__KHEREP_CLAUDE_HOME__/hooks/guard.js",
    ],
  };
  const expected = { allow: [
    `Read(${credentials}/**)`,
    `Bash(find ${workspace}/apps -type f \\(-name *.js\\))`,
    `${claudeHome}/hooks/guard.js`,
  ] };
  assert.deepEqual(substituteTemplatePaths(value, "mac", workspace, credentials, claudeHome), expected);
  const winExpected = { allow: [
    `Read(${substituteTemplatePaths("__KHEREP_CREDENTIALS_ROOT__", "win", workspace, credentials, claudeHome)}/**)`,
    `Bash(find ${substituteTemplatePaths("__KHEREP_WORKSPACE__", "win", workspace, credentials, claudeHome)}/apps -type f \\(-name *.js\\))`,
    `${substituteTemplatePaths("__KHEREP_CLAUDE_HOME__", "win", workspace, credentials, claudeHome)}/hooks/guard.js`,
  ] };
  assert.deepEqual(substituteTemplatePaths(value, "win", workspace, credentials, claudeHome), winExpected);
});

test("Mac permission filter drops unresolved Windows drive grants only", () => {
  const settings = { permissions: { allow: [
    "Read(//d//**)",
    "Read(//c/ProgramData/chocolatey/**)",
    "Read(/d/untranslated-drive-path/**)",
    "Read(C:\\Windows\\System32\\**)",
    `Read(${workspace}/**)`,
    "Bash(npm run test:*)",
  ] } };
  filterMacPermissions(settings);
  assert.deepEqual(settings.permissions.allow, [
    `Read(${workspace}/**)`,
    "Bash(npm run test:*)",
  ]);
});

test("profile rendering drops legacy direct inference HTTP and obsolete MCP grants", () => {
  const settings = { permissions: { allow: [
    "Bash(curl http://localhost:8000*)",
    "Bash(ssh mac curl http://127.0.0.1:1234/v1/models)",
    "Bash(curl http://127.0.0.1:5173*)",
    "Bash(node ~/.claude/kherep/local-inference/runner.mts:*)",
    "mcp__n8n-mcp__n8n_list_workflows",
  ] } };
  filterManagedDisallowedPermissions(settings);
  assert.deepEqual(settings.permissions.allow, [
    "Bash(curl http://127.0.0.1:5173*)",
    "Bash(node ~/.claude/kherep/local-inference/runner.mts:*)",
  ]);
});

// OP-754. Verwaltete Skripte sollen den Credentials-Root aus der Umgebung
// aufloesen statt ihn als Literal zu fuehren.
//
// Der Test prueft den VERTRAG, nicht die Implementierung. Die erste Fassung
// verglich gegen resolveProfilePath() - also gegen genau den Aufruf, den der
// Code machte. Sie war gruen, waehrend der gerenderte Wert unter win die
// Backslash-Form trug und jeden bash-Konsumenten fail-closed abbrechen liess
// (drift-check.sh, ueber kherep_validate_shell_path in profile.sh). Ein Test,
// der dieselbe falsche Annahme kodiert wie der Code, beweist nichts.
test("OP-754 rendered credentials root is the call value and stays bash-usable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op754-render-"));
  // Genau die Form, die beim Renderer wirklich ankommt: MSYS wandelt das
  // bash-Argument /d/... in D:/... um, bevor node.exe es sieht. Die erste
  // Fassung dieses Tests fuhr eine POSIX-Eingabe und war deshalb gruen,
  // waehrend der ausgelieferte Wert unbrauchbar war.
  const sentinel = "D:/sentinel-cred-root";
  const expected = "/d/sentinel-cred-root";
  const sourceUser = path.join(dir, "user.src.json");
  const sourceProject = path.join(dir, "project.src.json");
  const outUser = path.join(dir, "user.out.json");
  const outProject = path.join(dir, "project.out.json");
  fs.writeFileSync(sourceUser, JSON.stringify({ env: {
    KEEP_ME: "1",
    KHEREP_WORKSPACE: "",
    USER_SETTING: "retained",
  } }));
  fs.writeFileSync(sourceProject, JSON.stringify({}));

  for (const profile of ["win", "mac"]) {
    renderSettings([
      profile, "/ws", sentinel, "/home/.claude",
      sourceUser, sourceProject, "-", "-", outUser, outProject,
    ]);
    const rendered = JSON.parse(fs.readFileSync(outUser, "utf8")) as { env: Record<string, string> };
    const value = rendered.env.KHEREP_CREDENTIALS_ROOT;
    assert.equal(value, expected, `${profile}: drive form must become the bash-visible path`);
    assert.ok(value.startsWith("/"), `${profile}: bash needs an absolute forward-slash path`);
    assert.ok(!value.includes("\\"), `${profile}: a backslash breaks every bash consumer`);
    assert.ok(!value.includes(":"), `${profile}: a drive colon breaks every bash consumer`);
    assert.equal(rendered.env.KEEP_ME, "1", `${profile}: injection must merge into env`);
    assert.equal(rendered.env.KHEREP_WORKSPACE, "/ws", `${profile}: installer workspace must define hook scope`);
    assert.equal(rendered.env.USER_SETTING, "retained", `${profile}: unrelated user settings must survive`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("neutral local-inference source preserves an existing configured profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-inference-render-"));
  const source = path.join(dir, "source.json");
  const existing = path.join(dir, "existing.json");
  const output = path.join(dir, "output.json");
  fs.writeFileSync(source, JSON.stringify({ schemaVersion: 2, backends: {}, profiles: { win: { backends: {} }, mac: { backends: {} } } }));
  const configured = { schemaVersion: 2, backends: { local: { transport: "stdio" } }, profiles: { win: { backends: { local: {} } } }, installedProfile: "win" };
  fs.writeFileSync(existing, JSON.stringify(configured));
  renderLocalInference(["win", source, existing, output]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), configured);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("malformed settings fail without echoing file content or path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-malformed-settings-"));
  const sentinel = "PRIVATE_FIXTURE_SENTINEL";
  const source = path.join(dir, `${sentinel}.json`);
  fs.writeFileSync(source, `{"secret":"${sentinel}"`);
  assert.throws(
    () => renderSettings(["mac", "/ws", "/creds", "/claude", source, source, "-", "-",
      path.join(dir, "user.json"), path.join(dir, "project.json")]),
    (error) => error instanceof Error && !error.message.includes(sentinel) && !error.message.includes(source)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Mac rendering preserves valid operator directories without restoring Windows paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-directories-"));
  const files = ["source-user.json", "source-project.json", "existing-user.json", "existing-project.json", "out-user.json", "out-project.json"]
    .map((name) => path.join(dir, name));
  fs.writeFileSync(files[0], "{}");
  fs.writeFileSync(files[1], JSON.stringify({ permissions: { additionalDirectories: ["/Users/example/Work"] } }));
  fs.writeFileSync(files[2], "{}");
  fs.writeFileSync(files[3], JSON.stringify({ permissions: { additionalDirectories: ["D:\\private", "/opt/operator-extra"] } }));
  renderSettings(["mac", "/Users/example/Work", "/Users/example/.kherep/credentials", "/Users/example/.claude",
    files[0], files[1], files[2], files[3], files[4], files[5]]);
  const project = JSON.parse(fs.readFileSync(files[5], "utf8")) as { permissions: { additionalDirectories: string[] } };
  assert.deepEqual(project.permissions.additionalDirectories, ["/Users/example/Work", "/opt/operator-extra"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("normalizeHookCommand faltet jede Home-Schreibweise auf ~ und laesst fremde Pfade in Ruhe (OP-1130)", () => {
  assert.equal(normalizeHookCommand("node $HOME/.claude/hooks/x.js", "/Users/me"), "node ~/.claude/hooks/x.js");
  assert.equal(normalizeHookCommand("node ${HOME}/.claude/hooks/x.js", "/Users/me"), "node ~/.claude/hooks/x.js");
  assert.equal(normalizeHookCommand("node /Users/me/.claude/hooks/x.js", "/Users/me"), "node ~/.claude/hooks/x.js");
  assert.equal(normalizeHookCommand("node C:\\Users\\Me\\.claude\\hooks\\x.js", "C:\\Users\\Me"), "node ~/.claude/hooks/x.js");
  assert.equal(normalizeHookCommand("node ~/.claude/hooks/x.js", "/Users/me"), "node ~/.claude/hooks/x.js");
  const foreign = "node $(npm root -g)/claude-baton/bin/claude-baton.js auto-checkpoint";
  assert.equal(normalizeHookCommand(foreign, "/Users/me"), foreign);
});

test("mergeHooks laesst keine bewahrte $HOME- oder Absolut-Variante neben dem verwalteten ~-Hook ueberleben (OP-1130)", () => {
  const home = os.homedir();
  const source = { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "node ~/.claude/hooks/a.js" }] }] };
  const existing = { SessionStart: [{ matcher: "startup", hooks: [
    { type: "command", command: "node $HOME/.claude/hooks/a.js" },
    { type: "command", command: `node ${home}/.claude/hooks/a.js` },
    { command: "node ~/.claude/hooks/a.js", type: "command" },
    { type: "command", command: "node ~/.claude/hooks/host-only.js" },
  ] }] };
  const merged = mergeHooks(source, existing);
  assert.deepEqual(merged.SessionStart.map((entry) => (entry.hooks || []).map((hook) => hook.command)),
    [["node ~/.claude/hooks/a.js", "node ~/.claude/hooks/host-only.js"]]);
});

test("mergeHooks treats quoted rendered paths and portable paths as one hook", () => {
  const rendered = path.join(os.homedir(), ".claude", "hooks", "a.mts");
  const source = { SessionStart: [{ matcher: "startup", hooks: [{
    type: "command", command: `node "${rendered}"`,
  }] }] };
  const existing = { SessionStart: [{ matcher: "startup", hooks: [{
    type: "command", command: "node ~/.claude/hooks/a.js",
  }] }] };
  const merged = mergeHooks(source, existing);
  assert.deepEqual(merged.SessionStart[0].hooks?.map((hook) => hook.command), [
    `node "${rendered}"`,
  ]);
});

// OP-1136. Waves 1-7 rename the hooks from .js to .mts. Without folding the
// extension into the identity the installer would keep BOTH commands: the
// managed .mts entry and the old .js line preserved from the live file. Every
// renamed hook would then run twice, once against a file the repo no longer
// ships. Canonical spelling is .js so the OP-1130 assertions stay unchanged.
test("normalizeHookCommand faltet die Skript-Endung auf eine Schreibweise (OP-1136)", () => {
  const canonical = "node ~/.claude/hooks/x.js";
  assert.equal(normalizeHookCommand("node ~/.claude/hooks/x.mts", "/Users/me"), canonical);
  assert.equal(normalizeHookCommand("node ~/.claude/hooks/x.mjs", "/Users/me"), canonical);
  assert.equal(normalizeHookCommand("node ~/.claude/hooks/x.cjs", "/Users/me"), canonical);
  assert.equal(normalizeHookCommand("node $HOME/.claude/hooks/x.mts", "/Users/me"), canonical);
  // Nur am Token-Ende. Ein Basename, der die Endung nur enthaelt, bleibt er selbst.
  assert.equal(normalizeHookCommand("node ~/.claude/hooks/x.mts.backup", "/Users/me"),
    "node ~/.claude/hooks/x.mts.backup");
  assert.equal(normalizeHookCommand("node ~/.claude/hooks/a.mts --flag", "/Users/me"),
    "node ~/.claude/hooks/a.js --flag");
});

// Gefaltet wird die Endung des Skripts, nicht jede Endung in der Zeile. Ein
// Argument, das denselben Suffix traegt, ist ein zweiter Pfad und keine zweite
// Hook-Identitaet: es steht danach unveraendert da (OP-1136).
test("normalizeHookCommand faltet nur das Skript-Token, nie ein gleichnamiges Argument (OP-1136)", () => {
  assert.equal(
    normalizeHookCommand("node ~/.claude/hooks/a.mts --config ~/.claude/hooks/b.mts", "/Users/me"),
    "node ~/.claude/hooks/a.js --config ~/.claude/hooks/b.mts",
  );
});

test("mergeHooks laesst die alte .js-Zeile neben dem verwalteten .mts-Hook nicht ueberleben (OP-1136)", () => {
  const source = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/commit-guard.mts" }] }] };
  const existing = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/commit-guard.js" }] }] };
  const merged = mergeHooks(source, existing);
  assert.deepEqual(merged.PreToolUse.map((entry) => (entry.hooks || []).map((hook) => hook.command)),
    [["node ~/.claude/hooks/commit-guard.mts"]]);
});

test("mergeHooks faltet nur die Endung, nie zwei verschiedene Hooks (OP-1136)", () => {
  const source = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/commit-guard.mts" }] }] };
  const existing = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/deploy-guard.js" }] }] };
  const merged = mergeHooks(source, existing);
  assert.deepEqual(merged.PreToolUse.map((entry) => (entry.hooks || []).map((hook) => hook.command)),
    [["node ~/.claude/hooks/commit-guard.mts", "node ~/.claude/hooks/deploy-guard.js"]]);
});
