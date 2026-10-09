# Codex Delivery Feedback Noise Plan

> **For agentic workers:** implement this plan task by task only after the Director authorizes production changes.

**Goal:** Keep Codex peer-message delivery reliable while replacing transport-heavy Stop feedback with one fixed concise cue.

**Architecture:** Keep the existing delivery state machine and `msg inbox --receive` path. SessionStart developer context owns the exact session-bound receive recipe. Stop owns only the fixed cue that starts one bounded continuation. The continuation retrieves framed peer context through the existing CLI, and its next Stop confirms what was offered.

**Current authorized phase:** Plan and synthetic regression tests only. No production hook, renderer, installer, permission, guard, merge, live configuration or installation change is authorized.

**Related plan:** [Codex Hook Noise Implementation Plan](2026-10-09-codex-hook-noise.md) covers the separate PostToolUse and research-feedback work in the same draft PR.

---

## Documented runtime boundary

The official Hooks reference documents that:

- [SessionStart](https://learn.chatgpt.com/docs/hooks#sessionstart) can add developer context for `startup`, `resume`, `clear` and `compact`, including after automatic compaction.
- [Stop](https://learn.chatgpt.com/docs/hooks#stop) uses a blocking reason as a new continuation prompt. Peer text, identifiers and transport details therefore stay out of that reason.
- [Common output fields](https://learn.chatgpt.com/docs/hooks#common-output-fields) describe `systemMessage` as a UI warning and say `suppressOutput` is parsed but not implemented. Neither is a hidden delivery channel.
- [Large hook output](https://learn.chatgpt.com/docs/hooks#large-hook-output) may spill to a file. This plan keeps the Stop reason small and uses the already-bounded receive context instead.

Installed source and repository tests establish configured behavior only. Actual Codex Desktop display, styling, wake behavior and model execution remain UNKNOWN until a later authorized target check.

## Delivery contract

The future Stop output is exactly:

```text
Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.
```

It remains a JSON `decision: "block"`. It contains no peer text, sender or message id, session id, CLI command, local path or escalation instruction.

SessionStart keeps the current identity, send command, session-list command and escalation note. It additionally gives the exact command:

```text
<cli> msg inbox --from <session-id> --receive
```

The developer context tells the agent to report relevant peer content with attribution without echoing transport instructions.

No hidden output channel, new hook event, MCP substitute, delivery-disable switch or `wake.enabled` interpretation is introduced.

## State and safety invariants

| Before | Event | After | Visible behavior |
| --- | --- | --- | --- |
| old `offered` | Stop | `delivered` | confirms the completed carrying turn |
| new `accepted` | eligible Stop | `accepted` | one concise block; content is not yet acknowledged |
| new `accepted` | explicit `--receive` | `offered` | nonce-framed peer context with authority warning |
| `offered` | repeated `--receive` | same offer count | no reoffer, even after the retry window |
| `offered` | next Stop | `delivered` | confirms the receive continuation completed |

Delivery remains at least once with bounded reoffers. Do not claim exactly once.

The Stop path keeps its current checks: enrollment, supported event, a valid Codex session id followed by the hook's session recording, arrivals, `continued === true`, continuation permission, bypass-permission refusal and shared continuation budget. Do not strengthen the continued check to require literal `false`.

The receive path keeps session validation before state changes, `reofferOffered: false`, message and byte bounds, nonce framing, peer-content authority, reply-depth limits and session isolation. Attribution ownership remains unchanged.

---

### Task 1: Add test-only contracts (current authorized phase)

**Files:**

- Create: `modules/control-plane/node/deliver-codex-feedback.contract.test.mts`
- Create: `modules/control-plane/node/codex-stop-receive-preservation.contract.test.mts`
- Create: `docs/superpowers/plans/2026-10-09-codex-delivery-feedback-noise.md`
- Modify only for a link: `docs/superpowers/plans/2026-10-09-codex-hook-noise.md`

- [x] Add RED assertions for the exact concise Stop cue and absence of CLI, path, ids and escalation detail.
- [x] Add RED SessionStart assertions for `startup`, `resume`, `clear` and `compact`, including the exact receive recipe and reporting instruction while preserving identity, send, list and escalation text.
- [x] Add a GREEN adversarial-field assertion proving peer-controlled values do not enter the current Stop reason.
- [x] Add GREEN preservation assertions for old-offer confirmation, new-arrival acceptance, explicit receive, next-Stop confirmation, repeated receive, continuation denial, bypass permissions, no enrollment, invalid input/session, unsupported events and no arrivals.
- [x] Leave every production file and existing test unchanged.

Run the preservation contract separately:

```sh
node --test modules/control-plane/node/codex-stop-receive-preservation.contract.test.mts
```

Expected now: all pass.

Run the future presentation contract separately:

```sh
node --test modules/control-plane/node/deliver-codex-feedback.contract.test.mts
```

Expected now: the adversarial peer-field check passes; the concise Stop and four SessionStart recipe checks fail for the intended absent behavior. The transport-hygiene check also fails because current Stop feedback contains the recipe and escalation note.

### Task 2: Move the recipe to SessionStart (future authorization required)

**Files later:**

- Modify: `modules/control-plane/node/deliver-codex.mts`
- Modify display assertions only: `modules/control-plane/node/deliver-codex.test.mts`
- Modify display assertions only: `modules/control-plane/node/codex-stop-receive.test.mts`

- [ ] Replace the current Stop reason plus appended recipe with the exact fixed cue.
- [ ] Extend SessionStart context with the exact session-bound receive command and reporting instruction.
- [ ] Keep `deliver-core.mts`, `msg-inbox.mts`, autonomy, framing, state transitions and attribution unchanged.
- [ ] Update old verbose-presentation assertions while retaining all existing process and state assertions.
- [ ] Make both new contract files green.

No new helper module is needed unless later implementation evidence proves the existing seam insufficient.

### Task 3: Verify preserved behavior (future implementation phase)

Run the unchanged affected suites:

```sh
node --test modules/control-plane/node/deliver-codex.test.mts modules/control-plane/node/codex-stop-receive.test.mts modules/control-plane/node/deliver-hook.test.mts modules/control-plane/node/deliver-confirm.test.mts modules/control-plane/node/delivery-identity.test.mts modules/control-plane/node/autonomy.test.mts modules/control-plane/node/msg-inbox.test.mts modules/control-plane/node/codex-sessions.test.mts codex/lib/external-delivery-attribution.test.mts
```

These suites retain process-level receive coverage, nonce-framed peer authority, reply-depth, byte and message bounds, retries, isolation, continuation budgets, identity checks and attribution ownership.

Then run:

```sh
npm run typecheck
npm run test:bootstrap
npm run test:control-plane
```

Report pass, fail and skip counts separately. Inspect the final remote diff and verify production changes are limited to the separately authorized implementation files.

### Task 4: Synthetic runtime acceptance (later, separately authorized)

- [ ] Start an isolated synthetic Codex runtime and capture SessionStart context for startup and resume.
- [ ] Exercise clear and compaction, then prove the receive recipe remains available through documented SessionStart developer context.
- [ ] Deliver a synthetic peer message, observe the concise Stop cue, and verify the model executes the recipe from developer context.
- [ ] Verify the response presents relevant peer content with attribution and does not echo transport instructions.
- [ ] Verify explicit receive changes `accepted -> offered` and the following Stop changes `offered -> delivered`.

This acceptance must not use private sessions, configuration, endpoints or inventories. Desktop UI styling and wake behavior remain UNKNOWN unless measured at the actual target under separate authority.
