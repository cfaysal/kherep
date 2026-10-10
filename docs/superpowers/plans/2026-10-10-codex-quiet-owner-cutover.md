# Codex quiet delivery: existing-owner cutover addendum

This addendum supplies plan and synthetic contracts for #365/#366. It does not implement production hooks, alter projection/configuration or authorize a live installation. The separate original-owner wake prerequisite was accepted in #367/#368. Intake reliability is separately merged in #369/#370.

## Verified event boundary

- Stop continuation records its prompt directly and continues the same turn, without executing UserPromptSubmit. [Official 0.160.1 source](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/core/src/session/turn.rs#L672).
- Queue text is stored as UserInput. [Pinned alpha processor](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/app-server/src/request_processors/thread_queue_processor.rs#L315).
- Dispatch uses the already loaded original owner and starts only while idle. Busy returns NotIdle and preserves the queue item. [Queue dispatch](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/ext/queue/src/service.rs#L405), [active-turn guard](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/core/src/session/turn_input.rs#L493).
- A successfully started UserInput goes through UserPromptSubmit before model processing. [Hook inspection](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/core/src/hook_runtime.rs#L677).

Astra traced both official pins; the coordinator independently read the relevant raw branches. Installed binary/tag identity and concrete quiet-candidate hook/UI execution remain UNKNOWN. Upstream source tests were not run for this trace.

## Two separately deliverable source stages

An installer-only staging plan is insufficient when hooks reference a checkout: updating that checkout can immediately change a later hook execution. Do not move the referenced checkout to the final quiet source before the context boundary is verified.

### A: Supply the receive recipe at both existing context boundaries

Only the Codex delivery adapter changes. SessionStart and every UserPromptSubmit supply the same exact session-bound receive command and current standalone/escalation guidance as additional developer context. Emit it even when the inbox is empty: a peer can arrive later during the turn. Subtract instruction bytes from the existing context budget. Preserve existing peer framing, identity/send/list context and report attribution.

Stop presentation remains unchanged in stage A. Enrollment, session validation, offer/confirm, receive, retries, message bounds, depth limits, continuation permission/budget and Claude stay unchanged. No new hook event, hidden output channel, activation registry or permission is proposed.

### B: Replace the visible Stop reason with the existing plan's fixed short cue

Activate this stage only after the relevant original owner crossed a verified stage-A SessionStart or UserPromptSubmit boundary and any pre-A running turn ended. The owner must use the recipe itself in functional acceptance. Queue submission, an installation marker, another chat's hook execution or a harness consuming the inbox is insufficient.

The condition applies per owner. A global checkout switch requires the condition for every affected currently running owner. A partial or stale directory does not establish that population. An idle loaded owner's next real user/queue input has a new prompt boundary; a busy old turn does not. If complete, permissible verification is unavailable, global stage-B activation remains UNKNOWN and must not be reported as safe. This addendum does not add a dynamic per-owner switch merely to avoid the acceptance problem.

The two stages should remain independently identifiable commits or pinned artifacts. Keep the corresponding source and target identity together. Stage B cannot be inferred from a final source build or an installer return value.

## Synthetic component contracts

New file: `modules/control-plane/node/deliver-codex-owner-context.contract.test.mts`.

It invokes the real adapter and real isolated inbox/session bookkeeping with reserved-domain and synthetic identities. It verifies:

1. Recipe developer context at SessionStart and UserPromptSubmit, including an empty inbox.
2. Refresh of an existing owner through UserPromptSubmit without another SessionStart.
3. Exact Windows and Unix command forms, own-session binding and unchanged escalation guidance.
4. Distinct recipes and offers for two owners; foreign peer content remains unoffered.
5. Recipe availability before a later arrival and no acknowledgement from the Stop cue alone.
6. Shared context-byte bounds and preserved nonce-framed peer content.
7. Recipe output alone never offers messages, and an unenrolled node remains silent.

The eight future recipe cases are expected RED on the accepted main source; the three preservation cases are expected GREEN. These tests do not execute a native model or establish installed behavior. No assertion claims that a manually invoked Stop produces a queue/prompt event.

Run:

```sh
node --test modules/control-plane/node/deliver-codex-owner-context.contract.test.mts
npm run typecheck
```

Keep the existing #366 concise-cue and state-preservation contracts. Update its delivery plan to reference this addendum when the branch owner integrates it. Production implementation must also update old output assertions without weakening process/state guards.

## Actual Desktop acceptance on each target platform

Use the same isolated original owner across both stages; a newly created chat alone does not exercise the cutover.

| Check | Required deciding evidence |
| --- | --- |
| Old owner, no new SessionStart | Exact stage-A artifact at hook target; owner's actual UserPromptSubmit output contains its own recipe |
| Busy pre-A turn | Queue item retained; no claim of current-turn refresh; old turn terminal before B activation |
| Initially empty inbox | Recipe delivered at prompt boundary before the later synthetic arrival |
| Stage B in the same owner | Actual short visible cue, without commands, paths, full IDs, escalation text or peer body |
| Model follow-through | Original owner executes receive and replies with the correlated synthetic nonce and attribution |
| Receipts | Same message accepted, offered once by real receive, delivered after continuation, sender acknowledgement converges |
| Negative cases | Wrong-owner packet unconsumed, denied continuation silent, bounded retries/depth/budget retained |
| Scope | Claude behavior/configuration unchanged; no permission or guard expansion |

Model and UI evidence must be inspected at the actual target. Keep test data synthetic; do not export private sessions, configuration, credentials, endpoints or infrastructure inventories. Record failing, skipped and untestable checks separately. Any rollout population or installed-artifact fact that is only indirectly supported remains UNKNOWN.

## Acceptance status

Verified on `test/codex-existing-owner-cutover`, based on accepted main `bfb8a8682ffb69842ff91bfc8b73a9a5ee51418c`:

- New contracts: 11 total, 3 preservation PASS, 8 intentional recipe RED, 0 skipped. Failures are the missing receive recipe, not fixture access errors.
- Existing delivery, confirmation, inbox, receive and session suites: 47 PASS, 0 FAIL, 0 skipped.
- `npm run typecheck`: PASS.
- `npm run test:bootstrap` through Git Bash: 477 total, 464 PASS, 3 FAIL, 10 skipped. The failures are Windows symlink `EPERM` in installer fixtures, previously reproduced on the accepted #368 source. The affected fixture and installer sources remain byte-identical through the current base. Bootstrap is not reported as green.
- Independent read-only review: the framing and second-owner coverage findings were corrected and re-reviewed; no further relevant findings.

Source trace is verified. Full local proof logs remain outside the checkout; the deciding counts and source identity are recorded at #365/#366. No hosted checks or native model execution are claimed for this plan/test artifact. Stage-A/B implementation, same-owner Desktop runtime acceptance and global cutover are not established by this addendum.
