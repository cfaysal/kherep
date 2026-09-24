import assert from "node:assert/strict";
import test from "node:test";
import { codexEnvironment, codexInvocation, normalizeWindowsCodexCommand } from "./codex-cli.mts";

test("uses the app execution alias for packaged Codex", () => {
  assert.equal(
    normalizeWindowsCodexCommand(
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.8383.0_x64__fixture\\codex.exe",
    ),
    "codex",
  );
  assert.equal(normalizeWindowsCodexCommand("C:\\Tools\\codex.exe"), "C:\\Tools\\codex.exe");
});

test("routes packaged Windows Codex executables through cmd.exe", () => {
  assert.deepEqual(
    codexInvocation(
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe",
      ["plugin", "add", "fixture with spaces"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d", "/s", "/c",
        '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe" plugin add "fixture with spaces"',
      ],
    },
  );
});

test("invokes native Windows Codex executables directly", () => {
  const command = "C:\\Users\\fixture\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  assert.deepEqual(
    codexInvocation(command, ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe"),
    { command, args: ["--version"] },
  );
});

test("keeps a safe Windows app alias unquoted", () => {
  assert.equal(
    codexInvocation("codex", ["--version"], "win32", "cmd.exe").args[3],
    "codex --version",
  );
});

test("uses direct invocation outside Windows", () => {
  assert.deepEqual(codexInvocation("codex", ["--version"], "darwin"), {
    command: "codex",
    args: ["--version"],
  });
});

test("omits the default CODEX_HOME for packaged Windows Codex", () => {
  const environment = { CODEX_HOME: "C:\\Users\\fixture\\.codex", KEEP: "yes" };
  assert.deepEqual(
    codexEnvironment(environment.CODEX_HOME, "win32", environment, "C:\\Users\\fixture"),
    { KEEP: "yes" },
  );
});

test("preserves an explicit non-default CODEX_HOME", () => {
  assert.deepEqual(
    codexEnvironment("D:\\Codex", "win32", { KEEP: "yes" }, "C:\\Users\\fixture"),
    { KEEP: "yes", CODEX_HOME: "D:\\Codex" },
  );
});
