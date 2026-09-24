# Kherep repository rules

## Agent entry and installation

- Read [README.md](README.md) first to understand Kherep and its current capabilities.
- Before installing, read [installation and rollback](docs/INSTALLATION.md). For Codex setup, also read [Codex integration](docs/CODEX.md).
- Identify the operating system, target runtime and intended workspace. Distinguish a fresh installation from an upgrade before selecting the documented installation path.
- Follow the applicable documented installer and inspect an isolated candidate before applying it to a live configuration. Preserve existing operator settings and review source-to-target drift for upgrades.
- Verify the installed source identity, hooks, runtime startup and configured tool discovery at the actual target before reporting installation success. Report passing, failing and untested capabilities separately.

## Repository development

- Follow the workspace's authorized work-item and commit conventions when present; do not assume a particular organization, tracker or key in the reusable product.
- Write new executable code as TypeScript with the .mts extension, ESM and explicit .mts relative imports.
- Use erasable syntax supported by Node.js type stripping. Do not use enums, namespaces, parameter properties or import-equals.
- Run npm run typecheck and npm run test:bootstrap before committing. Run focused functional tests for affected components. Report unavailable CI separately.
- When migrating existing JavaScript, update its legacy inventory, retired manifest, installers, references and tests together. Do not expand cleanup into unrelated language migration.
- Preserve configured integrations during upgrades. Change or retire a memory backend only with explicit authority and verified replacement and recovery behavior.
- Keep private operator configuration, endpoints, credentials, personal identities and host inventories outside the repository.
- Preserve independent changes and use one writer per worktree. Review the complete diff and test evidence before claiming completion.
- Obtain explicit authority before publication, deployment, history changes or changes to permissions. Verify the exact proposed artifact, relevant content and redistribution terms before acting.
