import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseServiceRunnerArgs, timestamped } from "./service-runner.mts";

test("the service runner accepts only an exact absolute managed binding", () => {
  const config = path.resolve("config");
  const workspace = path.resolve("workspace");
  assert.deepEqual(parseServiceRunnerArgs(["--config-dir", config, "--service-name", "com.example.node", "--workspace", workspace], "darwin"),
    { configDir: config, serviceName: "com.example.node", workspace });
  assert.throws(() => parseServiceRunnerArgs(["--config-dir", "relative", "--service-name", "x", "--workspace", workspace], "darwin"), /absolute/);
  assert.throws(() => parseServiceRunnerArgs(["--config-dir", config, "--service-name", "x", "--workspace", workspace, "--foreign", "x"], "darwin"), /usage/);
});

test("the service runner accepts Windows task names without weakening macOS labels", () => {
  const config = path.resolve("config");
  const workspace = path.resolve("workspace");
  const windows = ["--config-dir", config, "--service-name", "Kherep & Node", "--task-path", "\\Example\\", "--workspace", workspace];
  assert.deepEqual(parseServiceRunnerArgs(windows, "win32"),
    { configDir: config, serviceName: "Kherep & Node", taskPath: "\\Example\\", workspace });
  assert.throws(() => parseServiceRunnerArgs(windows, "darwin"), /task path applies only to Windows/);
  assert.throws(() => parseServiceRunnerArgs(windows.filter((value, index) => index < 4 || index > 5), "darwin"), /invalid service name/);
});

// Issue #420: the service log and the foreground daemon carry a time on every line.
test("a daemon log line passes through with an ISO timestamp in front", () => {
  const lines: string[] = [];
  timestamped((line) => lines.push(line))("kherep-node: connected as synthetic-node");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z kherep-node: connected as synthetic-node$/);
});
