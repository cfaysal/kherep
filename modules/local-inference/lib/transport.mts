import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import type { BackendSpec } from "./config.mts";
import { assertLoopback, endpointUrl } from "./profile.mts";

export type JsonRequest = (url: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;
export type BackendCall = <T = unknown>(route: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<T>;

export interface SpawnResultLike { status: number | null; stdout?: string | Buffer }
export type SpawnSyncLike = (command: string, args: string[], options: SpawnSyncOptions) => SpawnResultLike;

export interface KeepAliveProcess {
  killed: boolean;
  once(event: "error", listener: () => void): unknown;
  kill(): unknown;
}
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => KeepAliveProcess;

// Every process and network boundary is injectable, so the tests never reach
// a real backend, shell, or SSH host.
export interface TransportDependencies {
  requestJson?: JsonRequest;
  spawnSync?: SpawnSyncLike;
  spawn?: SpawnLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface ModelList { data?: { id?: string }[] }
export interface Backend { call: BackendCall; models: ModelList; close: () => void }

const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=5",
];

export function requestJson(urlString: string, method = "GET", body?: unknown, timeoutMs = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "https:" ? https : http;
    const data = body === undefined ? null : JSON.stringify(body);
    const req = lib.request(url, {
      method, timeout: timeoutMs,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) return reject(new Error(`Local endpoint HTTP ${status}`));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("Local endpoint returned invalid JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Local endpoint timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function shellToken(value: string): string {
  if (/^(?:~\/)?[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function sshJson(
  spec: BackendSpec, route: string, method = "GET", body?: unknown, timeoutMs = 120_000, spawn: SpawnSyncLike = spawnSync,
): unknown {
  assertLoopback(spec.endpoint);
  const url = endpointUrl(spec.endpoint, route);
  const remote = method === "POST"
    ? `curl -fsS --max-time 120 -H "Content-Type: application/json" --data-binary @- ${shellToken(url)}`
    : `curl -fsS --max-time 10 ${shellToken(url)}`;
  const result = spawn("ssh", [...SSH_OPTIONS, String(spec.sshHost), remote], {
    input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8",
    timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${spec.engine} SSH transport failed`);
  try { return JSON.parse(String(result.stdout)); }
  catch { throw new Error(`${spec.engine} SSH transport returned invalid JSON`); }
}

function localInvocation(argv: string[] | undefined, home: string): { command: string; args: string[] } | null {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  let command = argv[0];
  if (command.startsWith("~/") || command.startsWith("~\\")) {
    command = home.startsWith("/") ? path.posix.join(home, command.slice(2)) : path.join(home, command.slice(2));
  }
  return { command, args: argv.slice(1) };
}

function runLocalCommand(argv: string[] | undefined, home: string, spawn: SpawnSyncLike): SpawnResultLike {
  const invocation = localInvocation(argv, home);
  if (!invocation) return { status: 1 };
  return spawn(invocation.command, invocation.args, { stdio: "ignore", windowsHide: true });
}

function startLocalProcess(argv: string[] | undefined, home: string, launch: SpawnLike): KeepAliveProcess | null {
  const invocation = localInvocation(argv, home);
  if (!invocation) return null;
  const child = launch(invocation.command, invocation.args, { stdio: "ignore", windowsHide: true });
  child.once("error", function ignoreError() {});
  return child;
}

function runSshCommand(spec: BackendSpec, argv: string[] | undefined, spawn: SpawnSyncLike): SpawnResultLike {
  if (!spec.sshHost || !Array.isArray(argv) || argv.length === 0) return { status: 1 };
  const remote = argv.map((item) => shellToken(String(item))).join(" ");
  return spawn("ssh", [...SSH_OPTIONS, spec.sshHost, remote], {
    stdio: "ignore", timeout: 120_000, windowsHide: true,
  });
}

export function transportCall(spec: BackendSpec, dependencies: TransportDependencies = {}): BackendCall {
  const httpRequest = dependencies.requestJson || requestJson;
  const spawn = dependencies.spawnSync || spawnSync;
  return spec.transport === "ssh"
    ? <T,>(route: string, method?: string, body?: unknown, timeout?: number) =>
      Promise.resolve(sshJson(spec, route, method, body, timeout, spawn) as T)
    : <T,>(route: string, method?: string, body?: unknown, timeout?: number) =>
      httpRequest(endpointUrl(spec.endpoint, route), method, body, timeout) as Promise<T>;
}

export async function ensureBackend(spec: BackendSpec, home: string, dependencies: TransportDependencies = {}): Promise<Backend> {
  const call = transportCall(spec, dependencies);
  const keepAlive = spec.transport === "local"
    ? startLocalProcess(spec.keepAlive, home, dependencies.spawn || spawn)
    : null;
  function close(): void {
    if (keepAlive && !keepAlive.killed) keepAlive.kill();
  }

  try {
    try { return { call, models: await call<ModelList>("/models", "GET", undefined, 3_000), close }; } catch {}

    const syncSpawn = dependencies.spawnSync || spawnSync;
    const execute = spec.transport === "ssh"
      ? (argv: string[] | undefined) => runSshCommand(spec, argv, syncSpawn)
      : (argv: string[] | undefined) => runLocalCommand(argv, home, syncSpawn);
    const started = execute(spec.start);
    if (started.status !== 0 && spec.coldLaunch) execute(spec.coldLaunch);

    const pause = dependencies.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const attempts = Number.isInteger(spec.readyAttempts) ? Number(spec.readyAttempts) : 10;
    for (let i = 0; i < attempts; i++) {
      try { return { call, models: await call<ModelList>("/models", "GET", undefined, 3_000), close }; }
      catch { if (i + 1 < attempts) await pause(spec.readyDelayMs || 3_000); }
    }
    throw new Error(`${spec.engine} failed to become ready via ${spec.transport}`);
  } catch (error) {
    close();
    throw error;
  }
}
