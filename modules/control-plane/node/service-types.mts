import type { SourceIdentity } from "./daemon-source.mts";

export type ServicePlatform = "darwin" | "win32";

export interface ServiceBinding {
  serviceName: string;
  taskPath?: string;
  platform: ServicePlatform;
  workspace: string;
  configRoot: string;
  nodeExecutable: string;
  logFile?: string;
  supervisorGeneration?: string;
  source: SourceIdentity;
}

export interface ServiceAction { executable: string; arguments: string; workingDirectory?: string }

export interface WindowsServiceSummary {
  owner: string;
  logonType: string | null;
  runLevel: string | null;
  enabled: boolean | null;
  logonTriggers: number;
  triggerTypes: string[];
  logonTriggerEnabled: boolean | null;
  logonTriggerUser: string | null;
  actionTypes: string[];
  actions: ServiceAction[];
  executionEnvironment: Record<string, string>;
  securityDescriptor: string;
}

export interface NativeServiceSnapshot {
  definition: Buffer;
  security: Buffer;
  running: boolean | "unknown";
  pid?: number;
  windows?: WindowsServiceSummary;
  mac?: Record<string, unknown>;
}

export const FAILED_WRITE_SNAPSHOT = Symbol("failed-service-write-snapshot");
export type FailedServiceWrite = Error & { [FAILED_WRITE_SNAPSHOT]?: NativeServiceSnapshot };
// A stop error with this code was raised before the adapter took any native effect (#472).
export const STOP_NOT_ISSUED = "STOP_NOT_ISSUED";
// #582: the reason a candidate stop failed travels as one allowlisted code; the raw message is never recorded or printed.
export const STOP_CODES = ["STOP_BLOCKED_NATIVE_DESCENDANTS", "STOP_UNKNOWN_DESCENDANTS", "STOP_NATIVE_REFUSED",
  "STOP_UNPROVEN_TIMEOUT", "STOP_PROCESS_UNAVAILABLE", "STOP_IDENTITY_MISMATCH", "STOP_UNLISTED_ALIVE", "STOP_FAILED_OTHER"] as const;
export type StopCode = typeof STOP_CODES[number];
const STOP_CODE_OF_MESSAGE: ReadonlyArray<[string, StopCode]> = [
  ["STOP_BLOCKED_NATIVE_DESCENDANTS", "STOP_BLOCKED_NATIVE_DESCENDANTS"],
  ["STOP_UNKNOWN_DESCENDANTS", "STOP_UNKNOWN_DESCENDANTS"],
  ["launchctl could not prove the selected service stopped", "STOP_NATIVE_REFUSED"],
  ["Scheduled Task operation failed for the selected task", "STOP_NATIVE_REFUSED"],
  ["managed service verification timed out", "STOP_UNPROVEN_TIMEOUT"],
  ["selected LaunchAgent process is unavailable", "STOP_PROCESS_UNAVAILABLE"],
  ["LaunchAgent loaded pid does not match selected process", "STOP_IDENTITY_MISMATCH"],
  ["LaunchAgent loaded definition does not match selected definition", "STOP_IDENTITY_MISMATCH"],
  ["LaunchAgent loaded identity changed during stop preflight", "STOP_IDENTITY_MISMATCH"],
];
// #677: a stop error that carries an allowlisted code is classified by it; any other error by its exact message.
export function stopCode(error: unknown): StopCode {
  const code = (error as { code?: unknown } | null)?.code;
  if ((STOP_CODES as readonly unknown[]).includes(code)) return code as StopCode;
  const message = error instanceof Error ? error.message : "";
  return STOP_CODE_OF_MESSAGE.find(([text]) => text === message)?.[1] ?? "STOP_FAILED_OTHER";
}
export interface ServiceStopContext { pid: number; startedAt: string; sourceRoot?: string }
export interface ServiceClock { now: () => number; sleep: (milliseconds: number) => Promise<void> }
// #677: the one stop-proof deadline, computed by the lifecycle on `clock`; an adapter hook starts nothing after it.
export interface ServiceStopProof { alive: (pid: unknown) => boolean; clock: ServiceClock; deadline: number }

export interface ServiceAdapter {
  platform: ServicePlatform;
  currentUser(): Promise<string>;
  read(binding: ServiceBinding): Promise<NativeServiceSnapshot | null>;
  fresh(binding: ServiceBinding): Promise<Buffer>;
  freshSecurity(binding: ServiceBinding): Promise<Buffer>;
  adoptionNode(snapshot: NativeServiceSnapshot, pid?: number): Promise<string>;
  adoptionSourceRoot(snapshot: NativeServiceSnapshot, pid?: number): Promise<string>;
  adoptionLogFile(snapshot: NativeServiceSnapshot): Promise<string | undefined>;
  adopted(snapshot: NativeServiceSnapshot, binding: ServiceBinding, priorSourceRoot: string): Promise<Buffer>;
  retargeted(snapshot: NativeServiceSnapshot, binding: ServiceBinding): Promise<Buffer>;
  validateManaged(snapshot: NativeServiceSnapshot, binding: ServiceBinding): Promise<void>;
  processOwned(pid: number, binding: ServiceBinding, startedAt: string, sourceRoot?: string): Promise<boolean>;
  preflightStop(binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void>;
  write(binding: ServiceBinding, definition: Buffer, security: Buffer): Promise<void>;
  remove(binding: ServiceBinding): Promise<void>;
  stop(binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void>;
  // #677: optional; replaces the generic stop proof after `stop` for the same context, never runs after it.
  proveStopped?(binding: ServiceBinding, expected: ServiceStopContext, proof: ServiceStopProof): Promise<void>;
  start(binding: ServiceBinding): Promise<void>;
}
