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

Use the work tracking and commit conventions configured for your workspace. Keep organization-specific policy, personal configuration and credentials outside the reusable product.

Preserve upstream license notices and attribution when changing bundled third-party material.
