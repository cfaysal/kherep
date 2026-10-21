import { pidAlive, readDaemonState, type DaemonState } from "./daemon-state.mts";
import { compareSourceIdentity } from "./daemon-source.mts";
import { describeServiceDrain, type ServiceOwnerProbe } from "./service-drain.mts";
import type { nodePaths } from "./config.mts";
import { servicePlatform } from "./service-platform.mts";
import { serviceRoot, snapshotDigests, type ServiceReceipt } from "./service-records.mts";

// `service status` of a managed service. Moved from service-cli.mts for the 250-line budget (#582).
type Paths = ReturnType<typeof nodePaths>;
export interface StatusDependencies {
  adapterFor?: typeof servicePlatform;
  readState?: (paths: Paths) => DaemonState | null;
  alive?: (pid: unknown) => boolean;
  ownerProbe?: ServiceOwnerProbe;
}

export async function reportServiceStatus(paths: Paths, receipt: ServiceReceipt, dependencies: StatusDependencies): Promise<number> {
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
  // Issue #472: a drain left by a dead controller blocks admissions until an upgrade reclaims it.
  const drain = describeServiceDrain(paths, dependencies.ownerProbe);
  const staleDrain = drain === "stale" || drain === "unknown";
  const upgrade = `kherep-node service upgrade --source <clean checkout at ${receipt.binding.source.commit}>`;
  const recovery = drain === "unknown" ? "the service drain owner cannot be verified; inspect the service/drain owner file"
    : drain === "stale" ? `${upgrade} reclaims the stale drain`
      : native?.running === false && (!state || !alive(state.pid)) ? upgrade : undefined;
  const report = { ok: definitionMatch === true && source.status === "match" && runtimeMatch && !staleDrain, managed: true,
    serviceName: receipt.binding.serviceName, platform: receipt.binding.platform,
    ...(receipt.binding.taskPath ? { taskPath: receipt.binding.taskPath } : {}), running: native?.running ?? "unknown",
    definition: native ? (definitionMatch ? "match" : "mismatch") : "missing", source: source.status,
    authentication: authenticated ? "connected" : state?.disconnectedAt ? "disconnected" : "unknown",
    ownership: ownership ? "match" : "unknown", drain, ...(recovery ? { recovery } : {}) };
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}
