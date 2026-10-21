import crypto from "node:crypto";
import path from "node:path";

import type { DaemonState } from "./daemon-state.mts";
import {
  acquireServiceLock, readServiceReceipt, saveServiceBackup, serviceRoot, snapshotDigests, writeServiceReceipt,
} from "./service-records.mts";
import { pinServiceSource } from "./service-source.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  healthy, lifecycleDefaults, prepareStop, proveStopped, removeFresh, restorePrior, sourceMatches, verifyExact, verifyStopOwnership,
  type LifecycleDependencies,
} from "./service-lifecycle.mts";
import {
  assertSettled, exact, failedWriteSnapshot, receiptFor, recoveryBlocker, sameBinding, serviceFailure, stopNotIssued, type ServiceStage,
  type ServiceTransactionResult,
} from "./service-transaction-support.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

export { readServiceReceipt } from "./service-records.mts";
// #582: rollbackManagedService moved to service-rollback.mts (line budget); the import sites keep this name.
export { rollbackManagedService } from "./service-rollback.mts";

type Dependencies = LifecycleDependencies;

interface ActivateOptions {
  mode: "install" | "upgrade"; binding: ServiceBinding; sourceRoot?: string; adopt?: boolean; explicitServiceName?: boolean;
}
export async function activateManagedService(options: ActivateOptions, input: Dependencies): Promise<ServiceTransactionResult> {
  const release = acquireServiceLock(input.paths);
  try {
    const deps = lifecycleDefaults(input);
    let binding = options.sourceRoot
      ? { ...options.binding, source: pinServiceSource(options.sourceRoot, serviceRoot(input.paths)).identity }
      : options.binding;
    if (binding.platform === "win32") binding = { ...binding, supervisorGeneration: crypto.randomUUID() };
    const receipt = readServiceReceipt(input.paths);
    const existing = await input.adapter.read(binding);
    if (options.mode === "upgrade" && !receipt) throw new Error("managed service receipt is missing; install or adopt first");
    if (options.mode === "install" && receipt) throw new Error("service is already managed; use service upgrade");
    if (receipt && !sameBinding(receipt.binding, binding)) throw new Error("managed service binding does not match the receipt");
    if (existing?.running === "unknown") throw new Error("selected service running state is unknown");
    const recordedBefore = deps.readState(input.paths);
    if (!existing && recordedBefore && deps.alive(recordedBefore.pid)) {
      throw new Error("a live daemon is already recorded; refusing to start a duplicate service");
    }
    if (existing?.running === false && recordedBefore && deps.alive(recordedBefore.pid)) {
      throw new Error("a live daemon remains outside the stopped selected service");
    }
    let legacySourceRoot: string | undefined;
    if (existing && !receipt && options.adopt) {
      binding = { ...binding, nodeExecutable: await input.adapter.adoptionNode(existing, recordedBefore?.pid) };
      legacySourceRoot = await input.adapter.adoptionSourceRoot(existing, recordedBefore?.pid);
      const logFile = await input.adapter.adoptionLogFile(existing);
      if (binding.platform === "win32" && !logFile) throw new Error("Scheduled Task legacy log path is unavailable");
      if (logFile) binding = { ...binding, logFile };
    }
    if (receipt) {
      if (!existing) throw new Error("managed service definition is missing");
      const digests = snapshotDigests(existing);
      if (digests.definitionDigest !== receipt.definitionDigest || digests.securityDigest !== receipt.securityDigest) {
        throw new Error("managed service definition drifted from its receipt");
      }
      await input.adapter.validateManaged(existing, receipt.binding);
    } else if (existing && (!options.adopt || !options.explicitServiceName)) {
      throw new Error("an existing service requires explicit --service-name and --adopt");
    }

    let oldState: DaemonState | null = null;
    let oldBinding: ServiceBinding | undefined = receipt?.binding;
    if (existing) {
      oldState = recordedBefore;
      // #472: only a running service must match its daemon record; a live daemon beside a stopped one is refused above.
      if (receipt && existing.running === true && (!oldState?.source?.verified || !sourceMatches(receipt.binding.source, oldState.source)
        || oldState.service?.name !== receipt.binding.serviceName || oldState.service.platform !== receipt.binding.platform
        || oldState.service.taskPath !== receipt.binding.taskPath)) {
        throw new Error("running daemon does not match the managed service receipt");
      }
      if (!receipt && oldState?.source?.verified) {
        oldBinding = { ...binding, source: oldState.source, supervisorGeneration: undefined };
        if (path.resolve(oldState.source.root) !== path.resolve(legacySourceRoot!)) {
          throw new Error("legacy native source root does not match recorded daemon source");
        }
      }
      const provenanceRoot = oldBinding ? undefined : legacySourceRoot;
      if (existing.running === true) {
        if (!oldState?.connectedAt || oldState.disconnectedAt) throw new Error("selected service does not own the recorded daemon");
        const selectedBinding = oldBinding ?? binding;
        const context = { pid: oldState.pid, startedAt: oldState.startedAt, ...(provenanceRoot ? { sourceRoot: provenanceRoot } : {}) };
        if (deps.alive(oldState.pid)) {
          if (!await input.adapter.processOwned(oldState.pid, selectedBinding, oldState.startedAt, provenanceRoot)) {
            throw new Error("selected service does not own the recorded daemon");
          }
        } else {
          try { await input.adapter.preflightStop(selectedBinding, context); }
          catch { throw new Error("selected service does not own the recorded daemon"); }
        }
      }
    }
    const definition = existing
      ? receipt
        ? await input.adapter.retargeted(existing, binding)
        : await input.adapter.adopted(existing, binding, legacySourceRoot!)
      : await input.adapter.fresh(binding);
    const security = existing ? existing.security : await input.adapter.freshSecurity(binding);
    const backup = existing ? saveServiceBackup(input.paths, existing, { receipt, priorSource: oldBinding?.source, now: deps.now() }) : undefined;
    let endDrain = () => {};
    let clearLaunchPermit = () => {};
    let drainSafeToRelease = true;
    let mutationStarted = false;
    let stopIssued = false, writeAttempted = false, stage: ServiceStage = "stop";
    let candidateSnapshot: NativeServiceSnapshot | undefined;
    try {
      if (existing) {
        endDrain = beginServiceDrain(input.paths);
        const runningState = existing.running === true ? oldState : null;
        await prepareStop(oldBinding ?? binding, runningState, input, oldBinding ? undefined : legacySourceRoot);
        await verifyExact(input.adapter, binding, existing);
        await verifyStopOwnership(oldBinding ?? binding, runningState, input, oldBinding ? undefined : legacySourceRoot);
        mutationStarted = true;
        const sourceRoot = oldBinding ? undefined : legacySourceRoot;
        if (existing.running === true) {
          stopIssued = true;
          await input.adapter.stop(oldBinding ?? binding, oldState ? {
            pid: oldState.pid, startedAt: oldState.startedAt, ...(sourceRoot ? { sourceRoot } : {}),
          } : undefined);
          stage = "prove-stopped";
          await proveStopped(oldState?.pid, deps);
        }
      }
      mutationStarted = true;
      stage = "write"; writeAttempted = true;
      await input.adapter.write(binding, definition, security);
      stage = "verify";
      const written = await input.adapter.read(binding);
      if (!written) throw new Error("managed service definition was not created");
      candidateSnapshot = written;
      if (existing && !exact(written.security, security)) throw new Error("native service security changed during write");
      await input.adapter.validateManaged(written, binding);
      stage = "start";
      if (binding.platform === "win32") clearLaunchPermit = issueServiceLaunchPermit(input.paths, binding);
      await input.adapter.start(binding);
      stage = "health";
      const healthyState = await healthy(binding, oldState?.pid, input);
      stage = "settle";
      const active = await assertSettled(input, binding, written, healthyState, true);
      stage = "receipt";
      writeServiceReceipt(input.paths, receiptFor(binding, active, deps.now(), backup));
      return { serviceName: binding.serviceName, ...(binding.taskPath ? { taskPath: binding.taskPath } : {}),
        platform: binding.platform, source: binding.source, ...(backup ? { backupId: backup.id } : {}) };
    } catch (cause) {
      if (!mutationStarted) throw cause;
      candidateSnapshot ??= failedWriteSnapshot(cause);
      if (stopNotIssued(stage, cause)) stopIssued = false;
      let recovery = "unknown", blocker: string | undefined;
      try {
        if (existing) await restorePrior({ binding, previous: existing, previousBinding: oldBinding,
          previousPid: oldState?.pid, deps: input, candidate: candidateSnapshot, priorStopIssued: stopIssued });
        else await removeFresh(binding, input);
        recovery = "restored";
      } catch (error) { blocker = recoveryBlocker(error); }
      // #472: keep the drain once a write was attempted or while a daemon told to stop is still alive.
      if (recovery === "unknown" && (writeAttempted || (stopIssued && deps.alive(oldState?.pid)))) drainSafeToRelease = false;
      throw serviceFailure("SERVICE_ACTIVATION_FAILED", cause, recovery, stage, blocker);
    } finally { clearLaunchPermit(); if (drainSafeToRelease) endDrain(); }
  } finally { release(); }
}
