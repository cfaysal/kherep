import type { DaemonState } from "./daemon-state.mts";
import {
  acquireServiceLock, readServiceBackup, readServiceCandidate, readServiceReceipt, removeServiceCandidate, removeServiceReceipt, saveServiceBackup,
  snapshotDigests, writeServiceCandidate, writeServiceReceipt,
} from "./service-records.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  healthy, lifecycleDefaults, prepareStop, proveStopped, restorePrior, ROLLBACK_HEALTH_TIMEOUT_MS, verifyExact, verifyStopOwnership,
  type CandidateLoadedError, type LifecycleDependencies,
} from "./service-lifecycle.mts";
import {
  assertSettled, candidateInPlace, failedWriteSnapshot, recordedPriorBackup, recoveryBlocker, sameBinding, serviceFailure, stopNotIssued,
  type ServiceStage, type ServiceTransactionResult,
} from "./service-transaction-support.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

// #582: `service rollback` restores the receipt's definition, also over a recorded failed candidate (its bound prior
// backup replaces receipt.previousBackup). Moved from service-transaction.mts for the 250-line budget; re-exported there.
export async function rollbackManagedService(options: { binding: ServiceBinding }, input: LifecycleDependencies): Promise<ServiceTransactionResult> {
  const release = acquireServiceLock(input.paths);
  try {
    const deps = lifecycleDefaults(input);
    const receipt = readServiceReceipt(input.paths);
    if (!receipt || !sameBinding(receipt.binding, options.binding)) throw new Error("rollback backup is unavailable for this service");
    const current = await input.adapter.read(receipt.binding);
    if (!current || current.running === "unknown") throw new Error("current managed service state cannot be verified");
    const currentDigests = snapshotDigests(current);
    const receiptMatch = currentDigests.definitionDigest === receipt.definitionDigest && currentDigests.securityDigest === receipt.securityDigest;
    // #582: the record is consulted only while the receipt does not match (A2 P2-A); an invalid record then throws before any mutation.
    const pending = receiptMatch ? null : readServiceCandidate(input.paths);
    const pendingMatch = !receiptMatch && candidateInPlace(pending, current, receipt.binding);
    if (!receiptMatch && !pendingMatch) throw new Error("current managed service drifted from its receipt");
    const currentBinding = pendingMatch ? pending.binding : receipt.binding;
    await input.adapter.validateManaged(current, currentBinding);
    const priorFound = pendingMatch ? recordedPriorBackup(input.paths, pending, receipt)
      : receipt.previousBackup ? readServiceBackup(input.paths, receipt.previousBackup) : null;
    if (!priorFound) throw new Error("rollback backup is unavailable for this service");
    const { backup, snapshot: previous } = priorFound;
    if (!backup.priorSource || !deps.verifySource(backup.priorSource)) throw new Error("previous source cannot be verified; rollback refused");
    const priorBinding = backup.priorReceipt?.binding
      ?? { ...options.binding, source: backup.priorSource, supervisorGeneration: undefined };
    const state = deps.readState(input.paths);
    if (current.running === false && state && deps.alive(state.pid)) throw new Error("a live daemon remains outside the stopped selected service");
    if (current.running === true && (!state || !deps.alive(state.pid)
      || !await input.adapter.processOwned(state.pid, currentBinding, state.startedAt))) throw new Error("current daemon ownership cannot be verified");
    const safety = saveServiceBackup(input.paths, current, { receipt, priorSource: currentBinding.source, now: deps.now() });
    let endDrain = () => {};
    let clearLaunchPermit = () => {};
    let drainSafeToRelease = true;
    let mutationStarted = false;
    let stopIssued = false, writeAttempted = false, stage: ServiceStage = "stop";
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
        stopIssued = true;
        await input.adapter.stop(currentBinding, state ? { pid: state.pid, startedAt: state.startedAt } : undefined);
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
        // #582 decision 5: the prior source may predate #581 and maintain its queue before it connects, as in restorePrior.
        healthyState = await healthy(priorBinding, state?.pid, { ...input, timeoutMs: input.timeoutMs ?? ROLLBACK_HEALTH_TIMEOUT_MS },
          !backup.priorReceipt);
      }
      stage = "settle";
      await assertSettled(input, currentBinding, previous, healthyState, shouldRun);
      stage = "receipt";
      if (backup.priorReceipt) writeServiceReceipt(input.paths, backup.priorReceipt); else removeServiceReceipt(input.paths);
      removeServiceCandidate(input.paths);
      return { serviceName: priorBinding.serviceName, ...(priorBinding.taskPath ? { taskPath: priorBinding.taskPath } : {}),
        platform: priorBinding.platform, source: priorBinding.source, backupId: backup.id };
    } catch (cause) {
      if (!mutationStarted) throw cause;
      previousSnapshot ??= failedWriteSnapshot(cause);
      if (stopNotIssued(stage, cause)) stopIssued = false;
      let recovery = "unknown", blocker: string | undefined;
      try {
        await restorePrior({ binding: priorBinding, previous: current, previousBinding: currentBinding,
          previousPid: state?.pid, deps: input, candidate: previousSnapshot, priorStopIssued: stopIssued });
        recovery = "restored";
      } catch (error) {
        blocker = recoveryBlocker(error);
        if (blocker === "RECOVERY_CANDIDATE_LOADED" && previousSnapshot) {
          const d = snapshotDigests(previousSnapshot);
          if (!(d.definitionDigest === receipt.definitionDigest && d.securityDigest === receipt.securityDigest)) {
            try {
              writeServiceCandidate(input.paths, { version: 1, binding: priorBinding, ...d, backupId: safety.id, command: "rollback", stage,
                blocker, stopCode: (error as Partial<CandidateLoadedError>).stopCode ?? "STOP_FAILED_OTHER", failedAt: deps.now() });
            } catch { /* review P3 */ }
          }
        }
      }
      if (recovery === "unknown" && (writeAttempted || (stopIssued && deps.alive(state?.pid)))) drainSafeToRelease = false;
      throw serviceFailure("SERVICE_ROLLBACK_FAILED", cause, recovery, stage, blocker);
    } finally { clearLaunchPermit(); if (drainSafeToRelease) endDrain(); }
  } finally { release(); }
}
