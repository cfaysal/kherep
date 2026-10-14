import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseServiceRunnerArgs } from "./service-runner.mts";

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
