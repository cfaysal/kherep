---
name: kherep-deploy-workflow
description: Use when a task includes deploying, releasing, publishing, activating, installing, or promoting a change to an environment used by other people.
user-invocable: false
---

# Kherep Deploy Workflow

Deploy through the environments and checks defined by the current project. Treat source changes, builds, pushes, releases, and deployment as separate states, and verify the artifact at the destination before reporting delivery.

## Discover the release contract

Read the repository instructions, release documentation, CI configuration, deployment scripts, and current environment metadata. Establish:

- the target artifact and environment;
- the approved deployment command or tool;
- required tests and validation gates;
- rollback or recovery procedure;
- whether permissions, scopes, data migrations, billing, or public visibility change;
- who may authorize the external action.

If the project does not define an environment sequence, propose the smallest safe progression that matches the user's setup. Do not invent development, staging, production, host, cluster, branch, or provider names.

## Release sequence

1. Verify the intended diff and build the exact artifact using project-supported commands.
2. Run functional checks proportional to the change.
3. Validate security-sensitive configuration and surface permission or scope changes before deployment.
4. Deploy only to a target already authorized by the user or governing project policy.
5. Measure the destination state using an artifact version, digest, checksum, deployment receipt, or direct behavior check.
6. Report the source revision, artifact identity, target, evidence, and any rollback limitation.

## Authorization gates

Require explicit authority for a production release, public publication, marketplace submission, destructive migration, expanded permissions, or another consequential external action unless the active task already grants it. Silence is not approval.

Documentation-only changes require no runtime deployment unless the project says otherwise.

## Safety rules

- Never bypass a repository deploy guard, permission review, or approval gate.
- Never guess credentials, endpoints, target names, or tool parameters.
- Never expose secrets in command lines, logs, receipts, or chat.
- Never treat a successful build or upload command as proof that the destination runs the new artifact.
- Prefer the project's reversible release mechanism and stop when rollback is unknown for a risky change.

## Receipt

Report `RESULT`, `SOURCE`, `ARTIFACT`, `TARGET`, `VERIFY`, and `ROLLBACK`. Mark checks as passed, failed, skipped, or not testable.
