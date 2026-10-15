# Claude idle-wake recovery diagnostics implementation plan

Goal: preserve the existing guarded Claude listener while making restart prerequisites and listener evidence visible.

Architecture: one small read-only diagnostic beside the existing doctor checks, one receiver parity regression, and documentation corrections. There is no enrollment CLI, policy mutation, remote route, transport change, or wake-hook change.

Tech stack: TypeScript `.mts`, Node built-in tests, existing policy, session snapshot, permission mode, listener lock and scope records.

## Task 1: receiver behavior regression

Files: add `modules/control-plane/node/wake-receiver-parity.test.mts`.

- Use two synthetic full UUIDs as caller session ids, one representative of Claude and one of Codex.
- Prove that the same accepted receiver messages produce the same decisions.
- Keep wildcard-only, missing-mode `SessionStart` refused.
- Keep exact listing plus known safe mode and successful launch inspection able to arm and wake.
- Keep unknown and bypass modes refused.
- Keep an ordinary permission-bearing `Stop` able to wake through wildcard policy.
- Label the fixture as synthetic and never present it as live runtime evidence.

## Task 2: honest local readiness diagnostics

Files: add `modules/control-plane/node/wake-readiness.mts` and its test; wire it through `doctor-local.mts`, `doctor.mts`, and `doctor.test.mts`.

- Preserve the session listing's unseen-runtime metadata and count only observed idle rows from a valid local snapshot at most two listing intervals old.
- Report missing, unreadable and stale snapshots as unknown.
- Label snapshot completeness as complete, partial, or unknown for a legacy snapshot, without presenting observed rows as the total current population.
- Separate observed policy eligibility, explicit restart authority, remembered permission mode and live listed-listener evidence without deriving a ready verdict.
- Verify lock and scope token agreement, scope listing, process liveness and listener age without returning token values or session ids.
- Distinguish an absent lock from a failed lock read.
- Preserve intentional opt-out and keep diagnostics read-only.

## Task 3: documentation and regression gates

Files: update `docs/INSTALLATION.md`, `modules/control-plane/README.md`, `modules/control-plane/ARCHITECTURE.md`, and the root `README.md` where the architecture promise is summarized.

- Explain that wildcard policy covers permission-bearing prompt and Stop arming.
- Explain the stricter exact-listing, mode and launch proof required for missing-mode restart arming.
- State that a policy edit cannot recreate an exited native `asyncRewake` association.
- Keep configured policy, tested behavior, verified listener state and live receipt as separate claims.
- Run focused diagnostics and receiver tests, existing wake guard suites, the Control Plane suite, `npm run typecheck`, and `npm run test:bootstrap`.

## Task 4: host restoration and delivery, integration owner only

- Restore only operator-authorized exact ids through the existing private versioned policy source.
- Obtain a genuine native owner hook event, then verify one original-owner receipt on each required host.
- Verify installed source identity and unchanged guards at the actual targets.
- Publish, merge, deliver and clean up only after the public candidate and live evidence are both accepted.
