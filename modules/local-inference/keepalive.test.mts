#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BackendSpec, LocalInferenceConfig } from "./lib/config.mts";
import type { KeepAliveProcess } from "./lib/transport.mts";
import { DEFAULT_CONFIG, ensureBackend, run } from "./runner.mts";

let pass = 0;
let fail = 0;
function check(name: string, condition: unknown): void {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"} | ${name}`);
}

function fakeKeepAlive(events: string[]): KeepAliveProcess {
  return {
    killed: false,
    once() {},
    kill() {
      this.killed = true;
      events.push("keepalive-stop");
    },
  };
}

(async () => {
  check("safe built-in profile carries no process command",
    DEFAULT_CONFIG.backends.win === undefined);

  const events: string[] = [];
  const child = fakeKeepAlive(events);
  const spec: BackendSpec = {
    engine: "vLLM",
    endpoint: "http://127.0.0.1:8000/v1",
    transport: "local",
    keepAlive: ["wsl", "-d", "Ubuntu", "--", "sleep", "infinity"],
  };
  const backend = await ensureBackend(spec, "C:\\Users\\tester", {
    requestJson: async () => {
      events.push("models-probe");
      return { data: [{ id: "test-model" }] };
    },
    spawn: () => {
      events.push("keepalive-start");
      return child;
    },
  });

  check("local backend starts keepalive before its first probe",
    events.join(",") === "keepalive-start,models-probe");
  check("keepalive remains active while backend is in use", child.killed === false);
  check("backend exposes an explicit keepalive cleanup", typeof backend.close === "function");
  if (typeof backend.close === "function") backend.close();
  check("backend cleanup stops the keepalive", child.killed === true);

  const failureEvents: string[] = [];
  const failureChild = fakeKeepAlive(failureEvents);
  let readinessFailed = false;
  try {
    await ensureBackend({
      ...spec,
      start: ["wsl", "-d", "Ubuntu", "--", "docker", "start", "vllm-qwen"],
      readyAttempts: 1,
    }, "C:\\Users\\tester", {
      requestJson: async () => { throw new Error("offline"); },
      spawn: () => failureChild,
      spawnSync: () => ({ status: 0 }),
      sleep: async () => {},
    });
  } catch {
    readinessFailed = true;
  }
  check("readiness failure is still reported", readinessFailed);
  check("readiness failure stops the keepalive", failureChild.killed === true);

  // outputPath rejects an output root whose real path differs from its lexical
  // path; os.tmpdir() can itself be a symlink (macOS /var -> /private/var).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-inference-keepalive-")));
  const config: LocalInferenceConfig = {
    schemaVersion: 2,
    backends: { win: { ...spec, keepAlive: spec.keepAlive } },
    profiles: {
      win: { backends: { win: { transport: "local" } } },
      mac: { backends: {} },
    },
  };
  const runEvents: string[] = [];
  const runChild = fakeKeepAlive(runEvents);
  try {
    const result = await run([
      "--backend", "win", "--public", "--reveal-output", "--task", "Return OK",
    ], {
      platform: "win32",
      env: {
        ...process.env,
        KHEREP_PROFILE: "win",
        KHEREP_WORKSPACE: root,
        KHEREP_CREDENTIALS_ROOT: path.join(root, "credentials"),
        KHEREP_LOCAL_OUTPUT_ROOT: path.join(root, "output"),
      },
      config,
      requestJson: async (url) => url.endsWith("/models")
        ? { data: [{ id: "test-model" }] }
        : { choices: [{ message: { content: "OK" } }] },
      spawn: () => runChild,
    });
    check("runner completes through a kept-alive backend", result.response === "OK");
    check("runner stops the keepalive after inference", runChild.killed === true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`RESULT | pass=${pass} fail=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
