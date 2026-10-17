import crypto from "node:crypto";
import path from "node:path";

import type { DaemonState } from "./daemon-state.mts";
import type { SourceIdentity } from "./daemon-source.mts";
import {
  acquireServiceLock, readServiceBackup, readServiceReceipt, removeServiceReceipt, saveServiceBackup,
  serviceRoot, snapshotDigests, writeServiceReceipt,
} from "./service-records.mts";
import { pinServiceSource } from "./service-source.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  healthy, lifecycleDefaults, prepareStop, proveStopped, removeFresh, restorePrior, sourceMatches, verifyExact, verifyStopOwnership,
  type LifecycleDependencies,
} from "./service-lifecycle.mts";
import {
  assertSettled, exact, failedWriteSnapshot, receiptFor, recoveryBlocker, sameBinding, serviceFailure, type ServiceStage,
} from "./service-transaction-support.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

export { readServiceReceipt } from "./service-records.mts";

type Dependencies = LifecycleDependencies;

interface ActivateOptions {
  mode: "install" | "upgrade"; binding: ServiceBinding; sourceRoot?: string; adopt?: boolean; explicitServiceName?: boolean;
}
interface Result { serviceName: string; taskPath?: string; platform: string; source: SourceIdentity; backupId?: string; recovery?: string }
export async function activateManagedService(options: ActivateOptions, input: Dependencies): Promise<Result> {
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
    let stopIssued = false, writeAttempted = false;
    let stage: ServiceStage = "stop";
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
          await input.adapter.stop(oldBinding ?? binding, oldState ? {
            pid: oldState.pid, startedAt: oldState.startedAt, ...(sourceRoot ? { sourceRoot } : {}),
          } : undefined);
          stopIssued = true;
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
      let recovery = "unknown";
      let blocker: string | undefined;
      try {
        if (existing) await restorePrior({ binding, previous: existing, previousBinding: oldBinding,
          previousPid: oldState?.pid, deps: input, candidate: candidateSnapshot, priorStopIssued: stopIssued });
        else await removeFresh(binding, input);
        recovery = "restored";
      } catch (error) { blocker = recoveryBlocker(error); }
      if (recovery === "unknown" && writeAttempted) drainSafeToRelease = false;
      throw serviceFailure("SERVICE_ACTIVATION_FAILED", cause, recovery, stage, blocker);
    } finally { clearLaunchPermit(); if (drainSafeToRelease) endDrain(); }
  } finally { release(); }
}

export async function rollbackManagedService(options: { binding: ServiceBinding }, input: Dependencies): Promise<Result> {
  const release = acquireServiceLock(input.paths);
  try {
    const deps = lifecycleDefaults(input);
    const receipt = readServiceReceipt(input.paths);
    if (!receipt || !receipt.previousBackup || !sameBinding(receipt.binding, options.binding)) throw new Error("rollback backup is unavailable for this service");
    const currentBinding = receipt.binding;
    const current = await input.adapter.read(currentBinding);
    if (!current || current.running === "unknown") throw new Error("current managed service state cannot be verified");
    const currentDigests = snapshotDigests(current);
    if (currentDigests.definitionDigest !== receipt.definitionDigest || currentDigests.securityDigest !== receipt.securityDigest) {
      throw new Error("current managed service drifted from its receipt");
    }
    await input.adapter.validateManaged(current, receipt.binding);
    const { backup, snapshot: previous } = readServiceBackup(input.paths, receipt.previousBackup);
    if (!backup.priorSource || !deps.verifySource(backup.priorSource)) throw new Error("previous source cannot be verified; rollback refused");
    const priorBinding = backup.priorReceipt?.binding
      ?? { ...options.binding, source: backup.priorSource, supervisorGeneration: undefined };
    const state = deps.readState(input.paths);
    if (current.running === false && state && deps.alive(state.pid)) throw new Error("a live daemon remains outside the stopped selected service");
    if (current.running === true && (!state || !deps.alive(state.pid)
      || !await input.adapter.processOwned(state.pid, currentBinding, state.startedAt))) throw new Error("current daemon ownership cannot be verified");
    const safety = saveServiceBackup(input.paths, current, { receipt, priorSource: receipt.binding.source, now: deps.now() });
    let endDrain = () => {};
    let clearLaunchPermit = () => {};
    let drainSafeToRelease = true;
    let mutationStarted = false;
    let stopIssued = false, writeAttempted = false;
    let stage: ServiceStage = "stop";
    let previousSnapshot: NativeServiceSnapshot | undefined;
    // #472: a running node stays running even when the backup was taken from a stopped service.
    const shouldRun = current.running === true || previous.running === true;
    try {
      endDrain = beginServiceDrain(input.paths);
      const runningState = current.running === true ? state : null;
      await prepareStop(currentBinding, runningState, input);
      await verifyExact(input.adapter, currentBinding, current);
      await verifyStopOwnership(currentBinding, runningState, input);
      mutationStarted = true;
      if (current.running === true) {
        await input.adapter.stop(currentBinding, state ? { pid: state.pid, startedAt: state.startedAt } : undefined);
        stopIssued = true;
        stage = "prove-stopped";
        await proveStopped(state?.pid, deps);
      }
      stage = "write"; writeAttempted = true;
      await input.adapter.write(currentBinding, previous.definition, previous.security);
      stage = "verify";
      previousSnapshot = await verifyExact(input.adapter, currentBinding, previous);
      let healthyState: DaemonState | undefined;
      if (shouldRun) {
        stage = "start";
        if (priorBinding.platform === "win32" && priorBinding.supervisorGeneration) {
          clearLaunchPermit = issueServiceLaunchPermit(input.paths, priorBinding);
        }
        await input.adapter.start(priorBinding);
        stage = "health";
        healthyState = await healthy(priorBinding, state?.pid, input, !backup.priorReceipt);
      }
      stage = "settle";
      await assertSettled(input, currentBinding, previous, healthyState, shouldRun);
      stage = "receipt";
      if (backup.priorReceipt) writeServiceReceipt(input.paths, backup.priorReceipt); else removeServiceReceipt(input.paths);
      return { serviceName: priorBinding.serviceName, ...(priorBinding.taskPath ? { taskPath: priorBinding.taskPath } : {}),
        platform: priorBinding.platform, source: priorBinding.source, backupId: backup.id };
    } catch (cause) {
      if (!mutationStarted) throw cause;
      previousSnapshot ??= failedWriteSnapshot(cause);
      let recovery = "unknown";
      let blocker: string | undefined;
      try {
        await restorePrior({ binding: priorBinding, previous: current, previousBinding: currentBinding,
          previousPid: state?.pid, deps: input, candidate: previousSnapshot, priorStopIssued: stopIssued });
        recovery = "restored";
      } catch (error) { blocker = recoveryBlocker(error); }
      if (recovery === "unknown" && writeAttempted) drainSafeToRelease = false;
      void safety;
      throw serviceFailure("SERVICE_ROLLBACK_FAILED", cause, recovery, stage, blocker);
    } finally { clearLaunchPermit(); if (drainSafeToRelease) endDrain(); }
  } finally { release(); }
}
