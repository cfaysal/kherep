# Contributing

Use Node.js 24, npm and a Git checkout. Source development and portable tests do not require access to an Atlassian site.

## Source setup

```sh
npm ci
npm run typecheck
npm run test:bootstrap
```

Read [AGENTS.md](AGENTS.md) and the instructions in the component you change. New executable Kherep source uses `.mts`, ESM and erasable TypeScript syntax.

## Component checks

| Change | Checks |
| --- | --- |
| Bootstrap and profiles | `npm run typecheck`, `npm run test:bootstrap` |
| Codex adapters | `npm run test:codex` |
| Shared modules | `npm run test:modules` |
| Jira and Confluence brokers | `npm run test:brokers` |
| Teamwork Graph | `node --test modules/twg/*.test.mts` |

On Windows, select Git for Windows Bash in the test process's `PATH` before WSL Bash. Do not change global shell configuration for a test run.

Keep production configuration out of tests. Tests that need an unavailable platform capability can skip; report skips separately from passing checks.

## Submitting changes

Keep changes focused and preserve unrelated work. Include the problem, resulting behavior and relevant verification. Update architecture and installation reference alongside changes to interfaces, authentication or wiring.

Track changes to Kherep in the repository's GitHub Issues. Open or reference an issue before a non-trivial change and close it from the pull request with `Closes #<number>`. Typo and documentation fixes can go straight to a pull request. Commits and branch names in this repository carry no external tracker keys.

Changes reach `main` only through a pull request, which is merged by rebase.

Keep organization-specific policy, personal configuration and credentials outside the reusable product. The work-item and commit conventions of a workspace where Kherep is installed apply to that workspace's repositories, not to contributions to Kherep.

Preserve upstream license notices and attribution when changing bundled third-party material.
