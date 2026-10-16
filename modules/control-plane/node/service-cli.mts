import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { configRoot, nodePaths, readConfig } from "./config.mts";
import { pidAlive, readDaemonState, type DaemonState } from "./daemon-state.mts";
import { captureSourceIdentity, compareSourceIdentity, runtimeSourceRoot } from "./daemon-source.mts";
import { ensureLauncher, type LauncherStatus } from "./launcher.mts";
import type { LifecycleDependencies } from "./service-lifecycle.mts";
import { servicePlatform, serviceSelector, supportedServicePlatform } from "./service-platform.mts";
import { readServiceReceipt, serviceRoot, snapshotDigests, type ServiceReceipt } from "./service-records.mts";
import { activateManagedService, rollbackManagedService } from "./service-transaction.mts";
import type { ServiceBinding } from "./service-types.mts";

export const SERVICE_USAGE = `  kherep-node service install --workspace <absolute> [--source <clean checkout>] [--service-name <name>] [--task-path <path>] [--adopt]
  kherep-node service upgrade [--source <clean checkout>]
  kherep-node service status
  kherep-node service rollback
  macOS --adopt uses the configured on-disk plist, not a complete snapshot of the loaded launchd cache.`;

export type ServiceCommand = { action: "install"; workspace: string; source?: string; serviceName?: string; taskPath?: string;
  adopt: boolean; explicitServiceName: boolean } | { action: "upgrade"; source?: string }
  | { action: "status" } | { action: "rollback" };

export function defaultServiceName(platform: ServiceBinding["platform"]): string {
  return platform === "win32" ? "KherepNode" : "org.kherep.node";
}

interface ServiceCliDependencies {
  root?: string;
  readReceipt?: (paths: ReturnType<typeof nodePaths>) => ServiceReceipt | null;
  adapterFor?: typeof servicePlatform;
  readState?: (paths: ReturnType<typeof nodePaths>) => DaemonState | null;
  alive?: (pid: unknown) => boolean;
  lifecycle?: Omit<LifecycleDependencies, "paths" | "adapter">;
}

const SERVICE_FAILURE_CODES = new Set(["SERVICE_ACTIVATION_FAILED", "SERVICE_ROLLBACK_FAILED"]);
export function safeServiceFailure(error: unknown): { ok: false; code: string; recovery: "restored" | "unknown" } | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; recovery?: unknown };
  if (typeof value.code !== "string" || !SERVICE_FAILURE_CODES.has(value.code)
    || (value.recovery !== "restored" && value.recovery !== "unknown")) return null;
  return { ok: false, code: value.code, recovery: value.recovery };
}

export function parseServiceCommand(argv: string[]): ServiceCommand {
  const rawAction = argv[0];
  if (!(rawAction === "install" || rawAction === "upgrade" || rawAction === "status" || rawAction === "rollback")) {
    throw new Error(`usage:\n${SERVICE_USAGE}`);
  }
  const action = rawAction;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv.slice(1), strict: true, options: { workspace: { type: "string" }, source: { type: "string" },
      "service-name": { type: "string" }, "task-path": { type: "string" }, adopt: { type: "boolean" } } });
  } catch { throw new Error(`usage:\n${SERVICE_USAGE}`); }
  const stringOption = (value: unknown): string | undefined => {
    if (value === undefined || typeof value === "string") return value;
    throw new Error(`usage:\n${SERVICE_USAGE}`);
  };
  const workspace = stringOption(parsed.values.workspace);
  const source = stringOption(parsed.values.source);
  const serviceName = stringOption(parsed.values["service-name"]);
  const taskPath = stringOption(parsed.values["task-path"]);
  const rawAdopt = parsed.values.adopt;
  if (rawAdopt !== undefined && typeof rawAdopt !== "boolean") throw new Error(`usage:\n${SERVICE_USAGE}`);
  const adopt = rawAdopt === true;
  if (action === "install") {
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("service install requires an absolute --workspace");
    if (source && !path.isAbsolute(source)) throw new Error("--source must be absolute");
    return { action, workspace: path.resolve(workspace), ...(source ? { source: path.resolve(source) } : {}),
      ...(serviceName ? { serviceName } : {}), ...(taskPath ? { taskPath } : {}), adopt,
      explicitServiceName: serviceName !== undefined };
  }
  if (action === "upgrade") {
    if (workspace || serviceName || taskPath || adopt) throw new Error(`usage:\n${SERVICE_USAGE}`);
    if (source && !path.isAbsolute(source)) throw new Error("--source must be absolute");
    return { action, ...(source ? { source: path.resolve(source) } : {}) };
  }
  if (workspace || source || serviceName || taskPath || adopt) throw new Error(`usage:\n${SERVICE_USAGE}`);
  return { action };
}

function installedBinding(command: Extract<ServiceCommand, { action: "install" }>, root: string): ServiceBinding {
  const platform = supportedServicePlatform();
  const sourceRoot = command.source ?? runtimeSourceRoot();
  const source = captureSourceIdentity(sourceRoot);
  const base = { platform, workspace: command.workspace, configRoot: root, nodeExecutable: process.execPath, source,
    ...(platform === "win32" ? { logFile: path.join(root, "control-plane", "service", "daemon.log") } : {}) };
  const service = serviceSelector(platform, command.serviceName ?? defaultServiceName(platform), command.taskPath);
  return { ...base, ...service };
}

function safeResult(value: Awaited<ReturnType<typeof activateManagedService>>, action: string): Record<string, unknown> {
  return { ok: true, action, serviceName: value.serviceName, platform: value.platform,
    ...(value.taskPath ? { taskPath: value.taskPath } : {}), source: { commit: value.source.commit, digest: value.source.digest, kind: value.source.kind },
    ...(value.backupId ? { backupId: value.backupId } : {}) };
}

// Issue #436. The stable launcher is derived from the receipt the transaction
// just wrote, outside the transaction: a failed write is reported and leaves the
// activation in place. Without a receipt (a rollback to a legacy service) the
// launcher still exists and fails closed.
function refreshLauncher(root: string, readReceipt: () => ServiceReceipt | null): LauncherStatus | "failed" {
  try {
    const binding = readReceipt()?.binding;
    return ensureLauncher(root, { platform: binding?.platform ?? supportedServicePlatform(),
      nodeExecutable: binding?.nodeExecutable ?? process.execPath }).status;
  } catch { return "failed"; }
}

export async function runService(argv: string[], dependencies: ServiceCliDependencies = {}): Promise<number> {
  const command = parseServiceCommand(argv);
  const root = dependencies.root ?? configRoot();
  const paths = nodePaths(root);
  const readReceipt = () => (dependencies.readReceipt ?? readServiceReceipt)(paths);
  const receipt = readReceipt();
  const report = (value: Awaited<ReturnType<typeof activateManagedService>>, action: string): number => {
    console.log(JSON.stringify({ ...safeResult(value, action), launcher: refreshLauncher(root, readReceipt) }, null, 2));
    return 0;
  };
  if (command.action === "status") {
    if (!receipt) { console.log(JSON.stringify({ ok: true, managed: false }, null, 2)); return 0; }
    const adapter = (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), receipt.binding.platform);
    const native = await adapter.read(receipt.binding);
    const digests = native ? snapshotDigests(native) : null;
    const state = (dependencies.readState ?? readDaemonState)(paths);
    const definitionMatch = digests?.definitionDigest === receipt.definitionDigest && digests.securityDigest === receipt.securityDigest;
    const source = compareSourceIdentity(receipt.binding.source, state?.source);
    const alive = dependencies.alive ?? pidAlive;
    const startedAt = state ? Date.parse(state.startedAt) : Number.NaN;
    const connectedAt = state?.connectedAt ? Date.parse(state.connectedAt) : Number.NaN;
    const authenticated = Number.isFinite(startedAt) && Number.isFinite(connectedAt) && connectedAt >= startedAt && !state?.disconnectedAt;
    const bindingMatch = state?.service?.name === receipt.binding.serviceName && state.service.platform === receipt.binding.platform
      && state.service.taskPath === receipt.binding.taskPath;
    let ownership = false;
    if (native?.running === true && state && authenticated && bindingMatch && source.status === "match" && alive(state.pid)) {
      try { ownership = await adapter.processOwned(state.pid, receipt.binding, state.startedAt); } catch { ownership = false; }
    }
    const runtimeMatch = native?.running === true && authenticated && bindingMatch && ownership;
    const report = { ok: definitionMatch === true && source.status === "match" && runtimeMatch, managed: true,
      serviceName: receipt.binding.serviceName, platform: receipt.binding.platform,
      ...(receipt.binding.taskPath ? { taskPath: receipt.binding.taskPath } : {}), running: native?.running ?? "unknown",
      definition: native ? (definitionMatch ? "match" : "mismatch") : "missing", source: source.status,
      authentication: authenticated ? "connected" : state?.disconnectedAt ? "disconnected" : "unknown",
      ownership: ownership ? "match" : "unknown" };
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (!readConfig(paths.config)) throw new Error("managed daemon service requires an enrolled node");
  if (command.action === "install") {
    if (!fs.statSync(command.workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error("service workspace is not a directory");
    const binding = installedBinding(command, root);
    const adapter = (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), binding.platform);
    const result = await activateManagedService({ mode: "install", binding, sourceRoot: command.source ?? runtimeSourceRoot(),
      adopt: command.adopt, explicitServiceName: command.explicitServiceName }, { ...dependencies.lifecycle, paths, adapter });
    return report(result, "install");
  }
  if (!receipt) throw new Error("managed service receipt is missing; install or adopt first");
  const adapter = (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), receipt.binding.platform);
  if (command.action === "upgrade") {
    const sourceRoot = command.source ?? runtimeSourceRoot();
    const checkout = captureSourceIdentity(sourceRoot);
    const binding = { ...receipt.binding, source: checkout };
    const result = await activateManagedService({ mode: "upgrade", binding, sourceRoot }, { ...dependencies.lifecycle, paths, adapter });
    return report(result, "upgrade");
  }
  const result = await rollbackManagedService({ binding: receipt.binding }, { ...dependencies.lifecycle, paths, adapter });
  return report(result, "rollback");
}
