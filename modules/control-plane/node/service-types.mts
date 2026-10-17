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
export interface ServiceStopContext { pid: number; startedAt: string; sourceRoot?: string }

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
  start(binding: ServiceBinding): Promise<void>;
}
