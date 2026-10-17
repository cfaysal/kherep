import type { DaemonState } from "./daemon-state.mts";
import { lifecycleDefaults, type LifecycleDependencies } from "./service-lifecycle.mts";
import { snapshotDigests, type ServiceBackup, type ServiceReceipt } from "./service-records.mts";
import {
  FAILED_WRITE_SNAPSHOT, STOP_NOT_ISSUED, type FailedServiceWrite, type NativeServiceSnapshot, type ServiceBinding,
} from "./service-types.mts";

export const SERVICE_STAGES = ["stop", "prove-stopped", "write", "verify", "start", "health", "settle", "receipt"] as const;
export type ServiceStage = typeof SERVICE_STAGES[number];

export const sameBinding = (left: ServiceBinding, right: ServiceBinding): boolean => left.serviceName === right.serviceName
  && left.taskPath === right.taskPath && left.platform === right.platform && left.workspace === right.workspace
  && left.configRoot === right.configRoot && left.nodeExecutable === right.nodeExecutable && left.logFile === right.logFile;
export const exact = (left: Buffer, right: Buffer): boolean => left.equals(right);

export function failedWriteSnapshot(cause: unknown): NativeServiceSnapshot | undefined {
  if (!(cause instanceof Error)) return undefined;
  const snapshot = (cause as FailedServiceWrite)[FAILED_WRITE_SNAPSHOT];
  return snapshot && Buffer.isBuffer(snapshot.definition) && Buffer.isBuffer(snapshot.security) ? snapshot : undefined;
}

export function receiptFor(binding: ServiceBinding, snapshot: NativeServiceSnapshot, now: string, backup?: ServiceBackup): ServiceReceipt {
  return { version: 1, binding, ...snapshotDigests(snapshot), activatedAt: now, ...(backup ? { previousBackup: backup.id } : {}) };
}

// Issue #472: success is reported only after the native service and its daemon are re-read as settled.
export async function assertSettled(input: LifecycleDependencies, binding: ServiceBinding, expected: NativeServiceSnapshot,
  daemon: DaemonState | undefined, shouldRun: boolean): Promise<NativeServiceSnapshot> {
  const snapshot = await input.adapter.read(binding);
  if (!snapshot) throw new Error("managed service definition disappeared after activation");
  if (!exact(snapshot.definition, expected.definition) || !exact(snapshot.security, expected.security)) {
    throw new Error("managed service definition changed during activation");
  }
  if (!shouldRun) return snapshot;
  if (snapshot.running !== true) throw new Error("managed service is not running after activation");
  if (daemon) {
    const recorded = lifecycleDefaults(input).readState(input.paths);
    if ((snapshot.pid !== undefined && snapshot.pid !== daemon.pid) || recorded?.pid !== daemon.pid || recorded.disconnectedAt) {
      throw new Error("managed service process does not match the recorded daemon");
    }
  }
  return snapshot;
}

// #472: a stop counts as issued unless the adapter tagged its failure as raised before any native effect.
export const stopNotIssued = (stage: ServiceStage, cause: unknown): boolean =>
  stage === "stop" && (cause as { code?: unknown } | null)?.code === STOP_NOT_ISSUED;

export function recoveryBlocker(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("RECOVERY_") ? code : "RECOVERY_STEP_FAILED";
}

type ServiceFailure<C extends string> = Error & { code: C; recovery: string; stage: ServiceStage; blocker?: string };

export function serviceFailure<C extends string>(code: C, cause: unknown, recovery: string, stage: ServiceStage,
  blocker?: string): ServiceFailure<C> {
  const fallback = code === "SERVICE_ROLLBACK_FAILED" ? "managed service rollback failed" : "managed service activation failed";
  const error = new Error(cause instanceof Error ? cause.message : fallback) as ServiceFailure<C>;
  error.code = code;
  error.recovery = recovery;
  error.stage = stage;
  if (blocker) error.blocker = blocker;
  return error;
}
