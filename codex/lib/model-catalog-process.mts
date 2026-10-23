import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AppServerClient, type AppServerSpawn, type KillReport } from "../../modules/control-plane/node/codex-app-server-client.mts";
import { codexCommand, findCodex } from "../../modules/control-plane/node/codex-binary.mts";
import { signalGroupReport } from "../../modules/control-plane/node/codex-process.mts";
import { windowsRelations, type ProcessRelation } from "../../modules/control-plane/node/process-relations.mts";
import { CatalogStageError, collectModelCatalog, type CatalogLimits, type CatalogStage } from "./model-catalog.mts";
import type { ModelCatalog } from "./model-policy.mts";

export interface CatalogProcessOptions extends CatalogLimits {
  executable?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  spawn?: AppServerSpawn;
  find?: () => string | null;
  // Test helpers may start a synthetic JSON-RPC server through this prefix.
  launchPrefix?: string[];
  opened?: (child: ChildProcessWithoutNullStreams) => void;
  killGroup?: (pid: number, signal: NodeJS.Signals) => KillReport;
  relations?: () => Promise<ProcessRelation[]>;
  probeGroup?: (pid: number) => GroupProbe;
  // How long a denied (EPERM) group probe may be re-asked; default 2000 ms.
  cleanupGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export type GroupProbe = "absent" | "present" | "denied";
export type { CatalogStage } from "./model-catalog.mts";

// The message names at most the failing stage; never stderr, paths, account data or causes.
// A cleanup-stage failure is unconfirmed cleanup by definition, so it needs no second suffix.
export class CatalogReadError extends Error {
  readonly code = "catalog-unavailable";
  readonly stage?: CatalogStage;
  readonly cleanupConfirmed: boolean;
  constructor(stage?: CatalogStage, cleanupConfirmed = true) {
    const unconfirmed = stage === "cleanup" || !cleanupConfirmed;
    super("Codex model catalog unavailable or cleanup unconfirmed" + (stage
      ? ` (stage: ${stage}${unconfirmed && stage !== "cleanup" ? "; cleanup unconfirmed" : ""})` : ""));
    this.stage = stage;
    this.cleanupConfirmed = !unconfirmed;
  }
}

// Issue #667: on macOS kill(-pgid, 0) answers EPERM for ~100 ms after a clean app-server
// exit in a fresh home, then ESRCH. EPERM is re-asked until ESRCH or the deadline; it is
// never read as absent. Any other code fails closed as "present".
function probeGroup(pid: number): GroupProbe {
  try { process.kill(-pid, 0); return "present"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "absent" : code === "EPERM" ? "denied" : "present";
  }
}
const GROUP_POLL_MS = 25;
async function groupGone(pid: number, options: CatalogProcessOptions): Promise<boolean> {
  const probe = options.probeGroup ?? probeGroup, now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.cleanupGraceMs ?? 2000);
  for (;;) {
    const state = probe(pid);
    if (state !== "denied") return state === "absent";
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(GROUP_POLL_MS, left));
  }
}
function hasDescendants(pid: number, rows: ProcessRelation[]): boolean {
  return rows.some((row) => row.pid === pid || row.ppid === pid);
}

// Metadata only. No configuration is read here; CODEX_HOME selects the caller's
// runtime context. The process is held, group-scoped and never started via a shell.
async function readCatalogProcess(options: CatalogProcessOptions): Promise<ModelCatalog> {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? (options.find ?? findCodex)();
  if (!executable) throw new Error("Codex executable unavailable for model catalog");
  const command = codexCommand(executable, [...options.launchPrefix ?? [], "app-server", "--listen", "stdio://"], platform);
  const child = (options.spawn ?? spawn as AppServerSpawn)(command.file, command.args, {
    stdio: "pipe", windowsHide: true, detached: true,
    ...(options.codexHome ? { env: { ...process.env, CODEX_HOME: options.codexHome } } : {}),
  });
  let exited = false, closed = false;
  child.once("exit", () => { exited = true; });
  child.once("close", () => { closed = true; });
  const owned = (): boolean => child.pid !== undefined && !exited && child.exitCode === null && child.signalCode === null;
  const kill = (signal: NodeJS.Signals): KillReport => {
    // POSIX group identity outlives its leader; Windows tree signalling must
    // retain a live, unreaped child root so a reused PID is never targeted.
    if (child.pid === undefined || platform === "win32" && !owned()) return "unconfirmed";
    return (options.killGroup ?? ((pid, value) => signalGroupReport(pid, value, platform)))(child.pid, signal);
  };
  let serverRequest = false;
  const client = new AppServerClient(child, { requestTimeoutMs: options.timeoutMs ?? 10_000, strict: true, kill,
    onServerRequest: () => { serverRequest = true; client.escalate(); } });
  const shutdown = async (): Promise<boolean> => {
    if (child.pid === undefined) { await client.shutdown(true); return false; }
    if (platform !== "win32") {
      const stopped = await client.shutdown(true);
      return stopped && await groupGone(child.pid, options);
    }
    // Use the existing tree signal while this exact ChildProcess still owns its
    // root. A post-signal snapshot measures only whether that owned root/tree remains.
    let before: ProcessRelation[];
    try { before = await (options.relations ?? windowsRelations)(); }
    catch (error) { if (owned()) kill("SIGKILL"); await client.shutdown(); throw error; }
    const tracked = new Set<number>([child.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of before) if (tracked.has(row.ppid) && !tracked.has(row.pid)) { tracked.add(row.pid); changed = true; }
    }
    const signalled = owned() && kill("SIGKILL") === "sent";
    await client.shutdown();
    const after = await (options.relations ?? windowsRelations)();
    return signalled && exited && closed && !after.some((row) => tracked.has(row.pid)) && !hasDescendants(child.pid, after);
  };
  try { options.opened?.(child); }
  catch (error) { await shutdown(); throw error; }
  return collectModelCatalog({ request: async (method, params, timeout) => {
    const result = await client.request(method, params, timeout);
    if (serverRequest) throw new Error("Unexpected model catalog server request");
    return result;
  }, notify: client.notify.bind(client), shutdown }, options);
}

// Raw RPC errors may include account details. The installer and CLI receive only
// this bounded error type, never stderr, paths, server messages or raw causes.
// Untagged errors arise only before the protocol starts.
export async function readAvailableModels(options: CatalogProcessOptions = {}): Promise<ModelCatalog> {
  try { return await readCatalogProcess(options); }
  catch (error) {
    throw error instanceof CatalogStageError ? new CatalogReadError(error.stage, error.cleanupConfirmed) : new CatalogReadError("start");
  }
}
