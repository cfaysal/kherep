import fs from "node:fs";
import path from "node:path";

import type {
  TaskControlExecuteBody, TaskControlQueryBody, TaskControlQueryResultBody, TaskControlRegisterBody,
  TaskControlRegistrationReceiptBody, TaskControlResultBody, TaskControlSubmitBody,
} from "../protocol-task-control.mts";
import { messageIds, readJson, writeJsonAtomic } from "./inbox.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { runVersionOf } from "./task-control-run.mts";
import { readTask, writeTask } from "./task-records.mts";

type OperationRecord = {
  version: 1;
  execute: TaskControlExecuteBody;
  status: "executing" | "completed";
  createdAt: string;
  updatedAt: string;
  result?: TaskControlResultBody;
  receiptAt?: string;
};

export type BeginOperation =
  | { kind: "execute" }
  | { kind: "inflight" }
  | { kind: "replay"; result: TaskControlResultBody };

const operationsDir = (paths: NodePaths): string => path.join(paths.taskControl, "operations");
const operationFile = (paths: NodePaths, operationId: string): string => path.join(operationsDir(paths), `${operationId}.json`);
const iso = (now: number): string => new Date(now).toISOString();

function readOperation(paths: NodePaths, operationId: string): OperationRecord | null {
  return readJson<OperationRecord>(operationFile(paths, operationId));
}

function writeOperation(paths: NodePaths, record: OperationRecord): void {
  ensureDir(operationsDir(paths));
  writeJsonAtomic(operationFile(paths, record.execute.operationId), record);
}

export function beginOperation(paths: NodePaths, execute: TaskControlExecuteBody, now: number = Date.now()): BeginOperation {
  const existing = readOperation(paths, execute.operationId);
  if (existing) {
    if (JSON.stringify(existing.execute) !== JSON.stringify(execute)) {
      return existing.result ? { kind: "replay", result: existing.result } : { kind: "inflight" };
    }
    return existing.status === "completed" && existing.result
      ? { kind: "replay", result: existing.result }
      : { kind: "inflight" };
  }
  const at = iso(now);
  writeOperation(paths, { version: 1, execute, status: "executing", createdAt: at, updatedAt: at });
  return { kind: "execute" };
}

export function completeOperation(paths: NodePaths, operationId: string, result: TaskControlResultBody,
  now: number = Date.now()): void {
  const existing = readOperation(paths, operationId);
  if (!existing || existing.status === "completed") return;
  writeOperation(paths, { ...existing, status: "completed", result, updatedAt: iso(now) });
}

export function pendingResults(paths: NodePaths): TaskControlResultBody[] {
  return messageIds(operationsDir(paths)).flatMap((operationId) => {
    try {
      const record = readOperation(paths, operationId);
      return record?.status === "completed" && record.result && !record.receiptAt ? [record.result] : [];
    } catch {
      return [];
    }
  });
}

export function receiptResult(paths: NodePaths, operationId: string, now: number = Date.now()): void {
  const existing = readOperation(paths, operationId);
  if (!existing || existing.status !== "completed" || !existing.result || existing.receiptAt) return;
  writeOperation(paths, { ...existing, receiptAt: iso(now), updatedAt: iso(now) });
}

export function recoverOperation(paths: NodePaths, operationId: string, now: number = Date.now()): void {
  const record = readOperation(paths, operationId);
  if (!record || record.status !== "executing") return;
  const { execute } = record;
  if (execute.action === "stop" && execute.expectedRunVersion) {
    const task = readTask(paths, execute.taskId);
    if (task && runVersionOf(task) === execute.expectedRunVersion) {
      writeTask(paths, { ...task, operatorStoppedAt: task.operatorStoppedAt ?? iso(now),
        taskControlRecoveryRunVersion: execute.expectedRunVersion }, now);
    }
  }
  const result: TaskControlResultBody = {
    name: "task.control.result", operationId, taskId: execute.taskId, state: "unknown", runtime: execute.runtime,
    taskState: "unknown", processState: "unknown", observedAt: iso(now), freshness: "fresh",
    stopSupported: false, stopConfirmed: false, errorCode: "recovery_required",
  };
  writeOperation(paths, { ...record, status: "completed", result, updatedAt: iso(now) });
}

export function recoverOperations(paths: NodePaths, now: number = Date.now()): void {
  for (const operationId of messageIds(operationsDir(paths))) {
    try {
      recoverOperation(paths, operationId, now);
    } catch {
      // An unreadable journal remains untouched and cannot be replayed automatically.
    }
  }
}

type ControlRequestRecord = {
  version: 1; submit: TaskControlSubmitBody; createdAt: string; updatedAt: string; result?: TaskControlQueryResultBody;
};

const requestsDir = (paths: NodePaths): string => path.join(paths.taskControl, "requests");
const requestFile = (paths: NodePaths, requestId: string): string => path.join(requestsDir(paths), requestId + ".json");

export { ensureDeliveryRegistrations, pendingRegistrations, readRegistrationAuthority, recordRegistrationReceipt }
  from "./task-control-registration.mts";

export function queueControlRequest(paths: NodePaths, submit: TaskControlSubmitBody, now: number = Date.now()): void {
  const existing = readControlRequest(paths, submit.requestId);
  if (existing) {
    if (JSON.stringify(existing.submit) !== JSON.stringify(submit)) throw new Error("task-control request id already has different arguments");
    return;
  }
  ensureDir(requestsDir(paths));
  const at = iso(now);
  writeJsonAtomic(requestFile(paths, submit.requestId), { version: 1, submit, createdAt: at, updatedAt: at });
}

export function readControlRequest(paths: NodePaths, requestId: string): ControlRequestRecord | null {
  return readJson<ControlRequestRecord>(requestFile(paths, requestId));
}

export function pendingControlSubmits(paths: NodePaths): TaskControlSubmitBody[] {
  return messageIds(requestsDir(paths)).flatMap((requestId) => {
    try {
      const record = readControlRequest(paths, requestId);
      return record && !record.result ? [record.submit] : [];
    } catch {
      return [];
    }
  });
}

export function applyQueryResult(paths: NodePaths, result: TaskControlQueryResultBody, now: number = Date.now()): void {
  const record = readControlRequest(paths, result.requestId);
  if (!record) return;
  const prior = record.result;
  if (result.action !== undefined && result.action !== record.submit.action) return;
  if (record.submit.taskId && result.taskId !== undefined && result.taskId !== record.submit.taskId) return;
  if (prior?.operationId && result.operationId && prior.operationId !== result.operationId) return;
  if (prior?.taskId && result.taskId && prior.taskId !== result.taskId) return;
  if (prior && prior.state !== "pending" && result.state === "pending") return;
  if (prior && prior.state !== "pending" && result.operationId === undefined && result.errorCode !== "grant_revoked") return;
  writeJsonAtomic(requestFile(paths, result.requestId), { ...record, result, updatedAt: iso(now) });
}

export function pendingControlQueries(paths: NodePaths): TaskControlQueryBody[] {
  return messageIds(requestsDir(paths)).flatMap((requestId) => {
    try {
      const record = readControlRequest(paths, requestId);
      return record?.result?.state === "pending" ? [{ name: "task.control.query" as const, requestId }] : [];
    } catch {
      return [];
    }
  });
}

// Issue #240: the newest settled status answer this node holds for a task, so
// `task show` can say what the target last answered instead of only the
// dispatch state. Unreadable request files are skipped.
export function latestStatus(paths: NodePaths, taskId: string): TaskControlQueryResultBody | null {
  return messageIds(requestsDir(paths)).flatMap((requestId) => {
    try {
      const record = readControlRequest(paths, requestId);
      const result = record?.result;
      return record?.submit.action === "status" && result?.taskId === taskId && result.state !== "pending"
        ? [{ result, at: record.updatedAt }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.at.localeCompare(a.at))[0]?.result ?? null;
}
