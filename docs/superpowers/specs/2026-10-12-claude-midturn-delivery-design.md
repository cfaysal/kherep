# Claude Mid-Turn Intercom Delivery Design

## Scope

GitHub issue #388 asks for parity with #374: a Claude Code session that is
working through a turn receives accepted peer messages before the turn ends,
without operator input. Today the Claude delivery hook runs only at
`UserPromptSubmit`, `Stop` and `StopFailure`, so a peer correction reaches a
busy session only after its turn.

Not in scope: waking idle sessions (`wake.sessions`, `wake.replies`), node
policy, onboarding, doctor-local, reply routing and closed-session delivery,
and any Codex behaviour.

## Hook contract

From the Claude Code hooks reference (<https://code.claude.com/docs/en/hooks>,
raw page read 2026-10-12):

- `PostToolUse` "Runs immediately after a tool completes successfully." An
  omitted or empty matcher runs it after every tool.
- Its decision control accepts `hookSpecificOutput.additionalContext`:
  "String added to Claude's context alongside the tool result."
- "Add context for Claude": Claude Code wraps the string in a system reminder,
  inserts it "next to the tool result", and "Claude reads the reminder on the
  next model request". A value over 10,000 characters moves to a file.
- "`PostToolUse` fires once per tool, which means it fires concurrently when
  Claude makes parallel tool calls."
- Hooks inside subagents fire with the same configured hooks, "and the input
  carries the `agent_id` and `agent_type` common input fields that identify the
  subagent"; `agent_id` identifies "the subagent or in-process teammate the hook
  fires in". `agent_type` alone also appears for a main session started with
  `--agent`.
- A command hook that reaches its `timeout` is cancelled and its output
  discarded. The default timeout for a command hook outside
  `UserPromptSubmit` is 600 seconds.

The output shape is the one `deliver-core.mts` `contextOutput` already writes
for `UserPromptSubmit` and `Stop`.

`PostToolBatch` was considered: it fires once per batch and so needs no lock.
Its minimum Claude Code version is not documented in the reference or found in
the changelog, and whether an older Claude Code accepts a settings file that
names an unknown hook event is UNKNOWN. `PostToolUse` is already wired by the
installer (attribution, edit watchers), so the delivery entry uses it.

## Behaviour

`deliver-hook.mts` accepts `PostToolUse` for the Claude runtime and hands it to
a new module, `deliver-midturn.mts`:

1. Main conversation only. An input that carries `agent_id` (subagent or
   in-process teammate) gets nothing: the context would land in the child, not
   in the session the message is addressed to. Parity with the Codex
   original-owner check of #374.
2. Permission mode `bypassPermissions` gets nothing; the messages stay
   `accepted` for the next user prompt. Parity with Codex busy consumption and
   the existing Claude `Stop` continuation gate.
3. Cheap exit: no accepted record and no unnoticed send failure for the
   session's references means no output, no lock and no directory. The hook
   fires on every tool call and must stay inert on a machine without an
   enrolled node.
4. One writer per session: an exclusive-create lock
   `listeners/<session_id>.deliver.lock` serialises concurrent `PostToolUse`
   calls of one session. A call that finds a live lock prints nothing (the
   holder delivers); a lock older than 5 seconds belongs to a dead process and
   is removed. Any other lock error prints nothing.
5. Inside the lock the existing `deliveryContext` runs with event
   `PostToolUse`: it offers only `accepted` records, never re-offers an
   `offered` one, frames them like the other events, marks them `offered` and
   adds unnoticed send-failure notices. The intro line says the messages
   arrived while the turn was running.

Receipt rule (issue #308, "progress alone is no read receipt"): the mid-turn
offer only marks `offered`. The turn's `Stop`, which runs once the turn
completed and therefore after at least one model request saw the context,
confirms `delivered`. `StopFailure` flags the offer `retry` and the next
`UserPromptSubmit` offers it again; a user interrupt leaves it `offered` until
the existing 10-minute re-offer rule. Delivery stays at least once.

No duplicate at the later boundary: `Stop` confirms every `offered` record
before it looks for new ones and injects only records still `accepted`. A
`UserPromptSubmit` for a prompt queued during the same turn re-offers an
`offered` record only after `StopFailure` or 10 minutes, as before.

Autonomous budgets (87c317b): mid-turn delivery starts no turn. It neither
checks nor spends the shared turn budget, writes no `wake.jsonl` decision and
needs no `wake` policy, exactly like `UserPromptSubmit` delivery. `Stop`
continuations and wakes keep their existing gates.

## Installer and doctor

`claude/settings.user.json` adds the delivery hook as the last entry of the
existing all-tools `PostToolUse` group, without a `timeout` field (the
600-second default makes a cancellation after the offer, which would discard
the output, practically impossible). The existing control-plane script
replacement in `bootstrap/render-profile-settings.mts` already replaces older
entries of that script per event, so no renderer change is needed;
`bootstrap/control-plane-hook-install.test.mts` covers the new event.
`doctor-hooks.mts` counts every hook command that names `deliver-hook.mts`, in
any event, so the new entry is counted without a code change; a test asserts
it.

## Tests

- `modules/control-plane/node/deliver-midturn.test.mts`: offer without
  receipt, confirming `Stop` without re-injection, no re-offer at a later
  `PostToolUse` or a queued `UserPromptSubmit`, `StopFailure` retry, subagent
  and bypass guards, no budget or audit writes, live and stale lock, inert
  without an enrolled node, and concurrent real hook processes delivering a
  message exactly once.
- `modules/control-plane/node/doctor-hooks.test.mts`: a `PostToolUse` entry is
  counted.
- `bootstrap/control-plane-hook-install.test.mts`: the rendered settings carry
  exactly one delivery entry on `PostToolUse`, inert as stored, and removing it
  is drift.

## Residual risks

- A `UserPromptSubmit` for a prompt queued at the same moment as a
  `PostToolUse` does not take the lock and can show one message twice in the
  same turn; it is still confirmed once.
- Two calls that both judge a dead process's lock stale can both remove it
  and both deliver: a double offer needs a crashed hook plus concurrent calls
  within the same window. `withBudgetLock` in `autonomy.mts` has the same race.
- A process killed after marking `offered` and before writing its output leaves
  an `offered` record the turn never saw; the `Stop` then confirms it. This is
  the same class as the existing `UserPromptSubmit` and `Stop` offers.
- Live behaviour on Windows and macOS Claude Code (actual hook firing, context
  placement, timing of `delivered`) is UNKNOWN until the two-node acceptance in
  issue #388 is measured.
