# Kherep Teamwork Graph integration

This module provides the same bounded TWG read contract to Claude and Codex on Windows and macOS. It does not contain the vendor executable, credentials, login logic, or a generic CLI pass-through.

## Runtime contract

`runtime/cli.mts` exposes `status`, `jira-get`, `jira-search`, `confluence-search`, and `help`. The client resolves the executable from `KHEREP_TWG_BIN`, `PATH`, or supported vendor install paths, then calls it with `execFile`, `shell: false`, a 15-second timeout, and a 256 KiB result limit.

Every command writes JSON to a wrapper-owned temporary file through TWG's `--output-file` option. This avoids agent-mode stdout summaries and prevents a response from choosing an arbitrary file path. The wrapper ignores raw stdout and stderr, validates the expected command envelope, and projects only allowlisted fields. Jira JQL history saving is explicitly disabled.

The current command contract targets verified TWG 1.2.7. Older command trees are not supported. In particular, natural Confluence search uses `confluence search text`.

This is a selected read-only surface, not complete coverage of the upstream TWG command tree. It uses the locally authorized TWG OAuth session and does not read credential or configuration files or pin an account or tenant. The operator must ensure that local session is the authorized identity before reading.

## Installation

The full Claude and Codex installers copy only `modules/twg/runtime` into their own `kherep/twg` directory. The canonical skill is projected separately from `claude/skills/kherep-twg` so Codex receives its normal path and safety adaptation.

For a focused installation from the repository:

```bash
node modules/twg/install.mts --runtime claude
node modules/twg/install.mts --runtime codex
```

The focused installer compares content before writing. Existing drift is moved below `<runtime-home>/backups/kherep-twg/<timestamp>/` before replacement. It does not access the network or read TWG configuration.

Vendor setup commands and the required privacy classification are documented in the `kherep-twg` skill. Full Kherep installs deliberately do not download or authenticate TWG.

## Tests

```bash
node --test modules/twg/*.test.mts
```

The tests use fake process boundaries and throwaway runtime homes. They do not call Atlassian services, run OAuth, or read host credentials.
