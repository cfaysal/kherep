# Managed node daemon services (#404)

The node currently documents a foreground daemon but neither installs nor upgrades a login service. Existing services can continue running loaded older source after a checkout upgrade, and doctor has no startup source identity. The operator has authorized implementation, Windows/macOS live acceptance and PR/rebase integration.

## Chosen interface

Add `kherep-node service install|upgrade|status|rollback`. This is an explicit daemon-only upgrade path, independent of the Claude/Codex adapter installer and of Claude sign-in. `install` supports a per-user macOS LaunchAgent or Windows logon Scheduled Task. Existing external definitions require explicit `--adopt` and an exact service name. Unrelated settings, triggers, environment and principal permissions remain intact. Linux and system-wide services are outside this change.

`upgrade --source <clean checkout>` snapshots the exact committed tracked source into an immutable per-user source pin, saves the previous complete service definition and managed receipt, stops only the selected service and verifies its old daemon exited, rewrites the selected entry, restarts it and waits for a new authenticated daemon with the expected startup source identity. No process is stopped by a PID alone. Unexpected service drift, incomplete source, changed identity, active incompatible service or an uncertain read aborts before mutation. There is one local exclusive upgrade lock. Failure restores saved bytes and reports measured recovery; an unverified recovery remains UNKNOWN. `rollback` uses a local saved receipt and verifies the same target again.

## Source and doctor

At startup, daemon state captures source root, committed revision when known and a deterministic source fingerprint, rather than inferring loaded code from the checkout later. Source identity excludes mutable runtime state, dependencies and untracked/private files. A pin carries a verified source manifest. The doctor daemon check exposes the recorded running source and compares it with the invoked checkout and applicable actual hook source bindings, accepting a verified equivalent pin. Missing startup identity is UNKNOWN and actionable; mismatch fails the check. Existing connection/readiness checks remain.

## Platform boundaries

macOS uses a user LaunchAgent with tokenized absolute ProgramArguments and launchctl bootstrap/bootout. Windows uses a current-user interactive logon Scheduled Task with a hidden launch and the product supervisor. Native session processes are never restarted. Fresh service definitions use least privilege. Adoption preserves existing principal/settings, refuses elevated or foreign ownership, and backs up definitions before any write. Generic examples use reserved names and paths, never operator-specific infrastructure.

The Windows task launches a fixed Node supervisor through headless `conhost`. Its bounded payload is the managed binding, not an arbitrary command. The supervisor verifies the immutable pin before every child start, rejects execution-affecting Node environment, appends both daemon streams to the retained service log and restarts an exited daemon after 30 seconds. Each activation has a new supervisor generation. During a drain only that exact binding can atomically consume the transaction's one-use launch permit, issued after the previous supervisor and daemon are proven absent; every other launch and restart waits. Stop retains the positively attested selected-task supervisor and direct daemon handles, proves no other children, stops the supervisor first and then stops only the retained daemon handle.

Windows adoption requires exactly one direct `Exec` action and refuses any additional action type. Admission leases carry controller PID, start-time and owner provenance; only a positively stale crashed lease is pruned, while uncertain ownership fails closed. Status succeeds only for a running native service whose live process, startup time, authenticated connection, source, config and service binding all match the managed receipt.

A legacy daemon without startup source identity may be adopted only when its exact native action yields the old source path and its Node executable, PID, process start and service provenance all match. That path is provenance, not a fabricated loaded-source identity: the backup explicitly records the old loaded source as `unknown`. Recovery may restore and read back exact native bytes while candidate absence is uncertain, but it never starts the unknown old source or a second candidate. Windows pins use the native system archive extractor so ambient Git Bash `tar` cannot reinterpret drive-letter paths.

## Acceptance and evidence

- Regression tests cover deterministic startup identity after checkout mutation, equivalent pin and mismatched hook/checkouts, unknown identity, definition rendering and adoption, unsafe identity/drift refusal, lock/retry exclusion, stop-before-start, failed restart and rollback readback.
- Root typecheck, bootstrap and affected Control Plane checks; independent specification, quality and simplification reviews.
- Actual Windows and macOS service install/adoption and a second CLI upgrade from a prior source, new PID/authenticated connection and exact expected source identity. Real doctor readback on both hosts. Backups and rollback measurements retained locally.
- Existing Queue/Receive/Stop behavior and enrollment/policy/profile hashes preserved. No synthetic peer messages without an independently recorded target and one-use authorization.
- PR closes #404 only after supported upgrade is tested and both live destinations are measured; source reaches main by rebase with public CI passing. Main artifacts are activated and independently read back before completion. Completed worktrees are cleaned after preserving unique evidence.
