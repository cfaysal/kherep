# Owner Task Control Worker Plan

## Goal

Add a strict metadata-only task-control protocol and a Registry-owned Durable Object ledger for authenticated owner status and stop operations.

## Shared protocol

- Keep typed task-control bodies inside the existing event envelope.
- Require sessions.own-task-control.v1 on owner and target, plus sessions.v1 on target.
- Accept exactly one status discovery reference. Require taskId plus expectedRunVersion for stop.
- Reject extra fields and use fixed error codes.
- Require a positive source-message associationVersion and echo it only in successful registration receipts.

## Provenance and storage

- Derive local owner and target from stored message metadata.
- Derive delegated owner, target, runtime, task, and sourceRequestId from stored task provenance.
- Store immutable per-task grants and separate origin associations.
- Move source-message discovery only for a higher association version with the same owner, target, and runtime.
- Bind each owner requestId to one immutable operation and canonical request fingerprint.
- Commit allowlisted target results before returning receipts.

## Delivery recovery

- Let NodeSession validate and forward typed events.
- Store operations before delivery.
- Retry the exact pending owner request during query.
- Drain at most four pages of 32 pending operations on reconnect.
- Replay duplicate request and result receipts from durable history.

## Verification

Run protocol tests, focused Worker grant and session tests, full Worker Vitest, root and Worker typechecks, Wrangler dry-run bundle, diff check, and a read-only review.

No commit, push, deployment, policy activation, API write, or README edit is in this worker scope.