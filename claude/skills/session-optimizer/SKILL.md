---
name: session-optimizer
description: Use when a long agent session has high token cost, context bloat, repeated noisy commands, slow turns, or an upcoming unrelated task transition.
---

# Session Optimizer

Reduce avoidable context and tool output while preserving the evidence and decisions needed to finish the task.

## Discover runtime controls

Inspect only the session-management commands and usage information exposed by the active runtime. Do not assume command names, cache durations, pricing, context limits, model families, or effort levels. Verify current product behavior before making cost claims.

## Priorities

1. Keep one substantial topic per session.
2. Preserve the objective, accepted constraints, decisions, changed files, verification evidence, and open risks.
3. Filter routine command output at the source with supported quiet flags or narrow queries.
4. Use a bounded worker for high-volume independent reading when delegation is available and useful.
5. Compact or checkpoint only through the active runtime's supported mechanism.

## During work

- Prefer targeted tests and searches before broader commands.
- Summarize passing output; retain exact failure evidence needed for diagnosis.
- Avoid repeatedly attaching or reading unchanged large files.
- Reuse current context for related follow-up work.
- When a recurring job needs separate context, define a worker by capability and cost budget from current configuration. Do not require a particular provider or model.

## Transitions

For an unrelated task, use the runtime's new-session or clear-context mechanism after saving a concise checkpoint if continuity matters. For a long continuing task, compact only when the retained-state contract is clear. Do not discard active approvals, privacy classification, unresolved failures, or uncommitted file ownership.

Skip this skill for a short, focused exchange where optimization overhead would exceed the benefit.
