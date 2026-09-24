---
name: forge-bulk-op-pattern
description: Use when designing or implementing a high-volume operation in a Forge app that processes many items through Forge SQL, Forge Storage, or Atlassian REST APIs.
user-invocable: false
---

# Forge Bulk Operation Pattern

Use this pattern for bulk reads or writes against Atlassian APIs from a Forge app.

## When to use

Trigger when any of these applies:

- More than about 50 items are processed.
- Forge SQL DML, Forge Storage, or Jira/Confluence REST APIs are called in a loop.
- The operation may exceed one resolver invocation.
- The frontend currently chunks work and repeatedly invokes a resolver.

## Required live verification

Before quoting timeouts, rate limits, queue limits, or concurrency limits, verify them with current official Forge documentation through an available documentation or browser tool. Versioned memory and the examples below are implementation leads, not current-limit authority. If a current limit cannot be verified, report it as `UNKNOWN` rather than guessing.

## Pattern

```text
[UI / scheduled trigger]
        |
        v  enqueue one job-start event
   @forge/events Queue (job-start)
        |
        v  persist job metadata; enqueue N item events
        |  concurrencyKey = jobId
        v
   @forge/events Queue (item-process)
        |  bounded in-flight work per job
        v
   idempotent item handler
        - process one item
        - update progress
        - record terminal item errors
```

### Concurrency key

- Use the same `concurrencyKey: jobId` for every item event in one job.
- Start with a conservative fixed concurrency cap and tune it only against current documented limits and observed 429s.
- Never use `itemId` as the concurrency key; that defeats the per-job cap.

### Idempotency

Forge events may be delivered more than once. Every item handler must be safe to repeat. Prefer:

- Natural keys and UPSERT for SQL writes.
- Conditional REST operations where supported.
- A dedupe record keyed by `(jobId, itemId)`.

### Error handling

- Item-level terminal errors: record the item and reason, surface them through job status, and avoid an infinite retry loop.
- Job-level transient failures such as auth or quota outages: let the queue retry according to the verified platform behavior.

## Do not use

- A frontend loop that invokes one resolver per item.
- One resolver that performs the entire batch.
- Unbounded `Promise.all(items.map(...))` against Atlassian services.
- A per-item concurrency key.

## Sources to verify

Use an available official-documentation search for current guidance on:

- events queue concurrency
- Forge SQL rate limits
- `@forge/events`

## Workspace references

Use implementations available in the current project as structural examples, after checking that they follow this pattern. If none exist, work from the pattern above and current official documentation. Do not assume another application's source is available.
