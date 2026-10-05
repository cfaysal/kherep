import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_CONTROL_CAPABILITY, TASK_CONTROL_ERROR_CODES, TASK_CONTROL_EVENT_NAMES, TASK_CONTROL_REPORT_CAPABILITY,
  isTaskControlEventBody, isTaskControlExecuteBody, isTaskControlQueryResultBody,
  isTaskControlRegisterBody, isTaskControlRegistrationReceiptBody, isTaskControlResultBody,
  isTaskControlSubmitBody,
} from "./protocol-task-control.mts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const TASK = "10000000-0000-4000-8000-000000000001";
const MESSAGE = "20000000-0000-4000-8000-000000000001";
const REQUEST = "30000000-0000-4000-8000-000000000001";
const OPERATION = "40000000-0000-4000-8000-000000000001";
const REGISTRATION = "50000000-0000-4000-8000-000000000001";
const RUN = "a".repeat(64);
const ORIGIN = { kind: "source-message" as const, sourceMessageId: MESSAGE };

test("exports the one opt-in capability and exact typed event names", () => {
  assert.equal(TASK_CONTROL_CAPABILITY, "sessions.own-task-control.v1");
  assert.deepEqual([...TASK_CONTROL_EVENT_NAMES], [
    "task.control.register", "task.control.registration.receipt", "task.control.submit", "task.control.execute",
    "task.control.result", "task.control.result.receipt", "task.control.query", "task.control.query.result",
  ]);
});

test("register and registration receipt expose grant details only on success", () => {
  const register = {
    name: "task.control.register", registrationId: REGISTRATION, taskId: TASK, runtime: "codex",
    associationVersion: 1, sourceMessageId: MESSAGE,
  };
  assert.equal(isTaskControlRegisterBody(register), true);
  assert.equal(isTaskControlRegisterBody({ ...register, associationVersion: 0 }), false);
  assert.equal(isTaskControlRegisterBody({ ...register, associationVersion: 1.5 }), false);
  assert.equal(isTaskControlRegisterBody({ ...register, ownerNodeId: OWNER }), false);
  assert.equal(isTaskControlRegisterBody({ ...register, path: "C:/private" }), false);

  const success = {
    name: "task.control.registration.receipt", registrationId: REGISTRATION, ok: true, taskId: TASK,
    ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex", origin: ORIGIN, grantVersion: 1, associationVersion: 1,
  };
  assert.equal(isTaskControlRegistrationReceiptBody(success), true);
  assert.equal(isTaskControlRegistrationReceiptBody({ ...success, errorCode: "source_not_found" }), false);
  const denied = {
    name: "task.control.registration.receipt", registrationId: REGISTRATION, ok: false,
    errorCode: "registration_conflict",
  };
  assert.equal(isTaskControlRegistrationReceiptBody(denied), true);
  assert.equal(isTaskControlRegistrationReceiptBody({ ...denied, ownerNodeId: OWNER }), false);
});

test("status accepts exactly one discovery reference and stop binds an exact run", () => {
  const status = { name: "task.control.submit", requestId: REQUEST, action: "status", sourceMessageId: MESSAGE };
  assert.equal(isTaskControlSubmitBody(status), true);
  assert.equal(isTaskControlSubmitBody({ ...status, taskId: TASK }), false);
  assert.equal(isTaskControlSubmitBody({ ...status, expectedRunVersion: RUN }), false);
  assert.equal(isTaskControlSubmitBody({ name: "task.control.submit", requestId: REQUEST, action: "status" }), false);

  const stop = { name: "task.control.submit", requestId: REQUEST, action: "stop", taskId: TASK, expectedRunVersion: RUN };
  assert.equal(isTaskControlSubmitBody(stop), true);
  assert.equal(isTaskControlSubmitBody({ ...stop, sourceRequestId: REQUEST }), false);
  assert.equal(isTaskControlSubmitBody({ ...stop, expectedRunVersion: "not-a-sha256" }), false);
});

test("execute contains only authoritative immutable metadata", () => {
  const execute = {
    name: "task.control.execute", operationId: OPERATION, requestId: REQUEST, taskId: TASK, action: "stop",
    ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex", origin: ORIGIN, grantVersion: 1, expectedRunVersion: RUN,
  };
  assert.equal(isTaskControlExecuteBody(execute), true);
  assert.equal(isTaskControlExecuteBody({ ...execute, pid: 42 }), false);
  assert.equal(isTaskControlExecuteBody({ ...execute, action: "status", expectedRunVersion: RUN }), false);
});

test("target results are measured and query results distinguish cached from unavailable", () => {
  const result = {
    name: "task.control.result", operationId: OPERATION, taskId: TASK, state: "succeeded", runtime: "codex",
    taskState: "running", processState: "running", runVersion: RUN, observedAt: "2026-09-29T10:00:00.000Z",
    freshness: "fresh", stopSupported: true, stopConfirmed: false,
  };
  assert.equal(isTaskControlResultBody(result), true);
  assert.equal(isTaskControlResultBody({ ...result, freshness: "cached" }), false);
  assert.equal(isTaskControlResultBody({ ...result, exception: "private stack" }), false);
  assert.equal(isTaskControlResultBody({ ...result, stopConfirmed: true, stopSupported: false }), false);
  assert.equal(isTaskControlResultBody({ ...result, stopConfirmed: true, processState: "running" }), false);
  const confirmedStop = { ...result, taskState: "stopped", processState: "closed",
    stopSupported: true, stopConfirmed: true };
  assert.equal(isTaskControlResultBody(confirmedStop), true);

  const pending = {
    name: "task.control.query.result", requestId: REQUEST, operationId: OPERATION, state: "pending",
    taskId: TASK, targetNodeId: TARGET, action: "status", freshness: "unavailable", errorCode: "target_offline",
  };
  assert.equal(isTaskControlQueryResultBody(pending), true);
  assert.equal(isTaskControlQueryResultBody({ ...pending, observedAt: "2026-09-29T10:00:00.000Z" }), false);

  const cached = {
    ...result, name: "task.control.query.result", requestId: REQUEST, targetNodeId: TARGET,
    action: "status", freshness: "cached",
  };
  assert.equal(isTaskControlQueryResultBody(cached), true);
  assert.equal(isTaskControlQueryResultBody({ ...cached, transcript: "secret" }), false);
  assert.equal(isTaskControlQueryResultBody({ ...cached, stopConfirmed: true, processState: "running" }), false);
  assert.equal(isTaskControlQueryResultBody({ ...confirmedStop, name: "task.control.query.result",
    requestId: REQUEST, targetNodeId: TARGET, action: "stop", freshness: "cached" }), true);
});

test("query results carry the reported task state and reason only with an operation (issue #240)", () => {
  assert.equal(TASK_CONTROL_REPORT_CAPABILITY, "sessions.own-task-control.report.v1");
  const cached = {
    name: "task.control.query.result", requestId: REQUEST, operationId: OPERATION, state: "succeeded", taskId: TASK,
    targetNodeId: TARGET, action: "status", freshness: "cached", runtime: "claude", taskState: "failed", processState: "closed",
    observedAt: "2026-09-29T10:00:00.000Z", stopSupported: false, stopConfirmed: false,
  };
  const reported = { ...cached, reportedState: "failed", reportedReason: "cwd does not exist on this node" };
  assert.equal(isTaskControlQueryResultBody(reported), true);
  assert.equal(isTaskControlEventBody(reported), true);
  assert.equal(isTaskControlQueryResultBody({ ...cached, reportedState: "dispatched" }), true);
  const pending = { name: "task.control.query.result", requestId: REQUEST, operationId: OPERATION, state: "pending", taskId: TASK,
    targetNodeId: TARGET, action: "status", freshness: "unavailable" };
  assert.equal(isTaskControlQueryResultBody({ ...pending, reportedState: "failed", reportedReason: "r" }), true);
  for (const bad of [{ reportedReason: "r" }, { reportedState: "lost" }, { reportedState: "failed", reportedReason: "" },
    { reportedState: "failed", reportedReason: "r".repeat(257) }, { reportedState: "failed", reportedReason: 7 }]) {
    assert.equal(isTaskControlQueryResultBody({ ...cached, ...bad }), false, JSON.stringify(bad));
  }
  assert.equal(isTaskControlQueryResultBody({ name: "task.control.query.result", requestId: REQUEST, state: "denied",
    freshness: "unavailable", errorCode: "task_unknown", reportedState: "failed" }), false, "no operation, no report");
  assert.equal(isTaskControlResultBody({ name: "task.control.result", operationId: OPERATION, taskId: TASK, state: "succeeded",
    runtime: "claude", taskState: "failed", processState: "closed", observedAt: "2026-09-29T10:00:00.000Z", freshness: "fresh",
    stopSupported: false, stopConfirmed: false, reportedReason: "r" }), false, "a target result stays unchanged");
});

test("all fixed node and Worker error codes are accepted without raw error text", () => {
  assert.deepEqual([...TASK_CONTROL_ERROR_CODES], [
    "invalid_frame", "capability_required", "source_not_found", "source_target_mismatch", "source_operator_owned",
    "task_unknown", "operator_owned", "ownership_unavailable", "foreign_owner", "registration_conflict",
    "request_conflict", "grant_revoked", "operation_unknown", "result_mismatch", "policy_disabled", "stale_run",
    "identity_unknown", "registration_stale", "recovery_required", "unsupported_runtime", "stop_failed",
    "target_offline", "internal_error",
  ]);
  for (const errorCode of TASK_CONTROL_ERROR_CODES) {
    assert.equal(isTaskControlQueryResultBody({
      name: "task.control.query.result", requestId: REQUEST, state: "denied", freshness: "unavailable", errorCode,
    }), true, errorCode);
  }
});

test("event dispatcher rejects every unrecognized field including private sentinels", () => {
  const frames = [
    {
      name: "task.control.register", registrationId: REGISTRATION, taskId: TASK, runtime: "codex",
      associationVersion: 1, sourceMessageId: MESSAGE,
    },
    { name: "task.control.submit", requestId: REQUEST, action: "status", taskId: TASK },
    { name: "task.control.query", requestId: REQUEST },
    { name: "task.control.result.receipt", operationId: OPERATION, storedState: "succeeded" },
  ];
  for (const frame of frames) {
    assert.equal(isTaskControlEventBody(frame), true, frame.name);
    for (const key of ["text", "prompt", "directive", "summary", "transcript", "cwd", "path", "pid", "pidStart", "rawError"]) {
      assert.equal(isTaskControlEventBody({ ...frame, [key]: "PRIVATE_SENTINEL" }), false, `${frame.name} accepted ${key}`);
    }
  }
  assert.equal(isTaskControlEventBody({ name: "task.control.shell", command: "whoami" }), false);
});
