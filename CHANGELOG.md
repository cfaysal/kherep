# Changelog

All notable changes to Kherep are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, a release that breaks a documented interface
increments the minor version; every other release increments the patch version.

## [Unreleased]

### Added

- Control Plane, Phase 1 (`modules/control-plane/`). A Cloudflare Worker
  `kherep-control` with two SQLite-backed Durable Objects: `NodeSession`
  holds each node's hibernatable WebSocket, the Ed25519 challenge handshake,
  a seq/ack pending-command log resent after reconnect and alarm-based
  offline detection (5-minute interval, offline after 3 missed intervals);
  `Registry` keeps nodes, runtimes, sessions, one-time enrollment codes and
  an audit trail. `/node/*` is gated only by the signed challenge; `/api/*`
  requires a Cloudflare Access JWT and fails closed without the team domain
  and AUD. Only `node.status`, `runtime.list` and `session.list` can be
  dispatched. The `kherep-node` CLI and daemon (`node onboard|status|unenroll`,
  `daemon`) generate and keep the node key locally, discover `claude`,
  `codex` and loopback LM Studio/Ollama, reconnect with jittered backoff up to
  60 s and enforce a local allowlist. The committed `wrangler.jsonc` holds
  placeholders only; deployment uses an operator-local override config.
  `npm run test:control-plane` runs the node tests; the Worker has its own
  package and test suite.
- `get --id <page> --body-only [--format storage|adf]` on both Confluence
  brokers prints only the page body to stdout, without metadata and without
  an added newline, so `> file` yields exactly the body. One request with
  the v2 `body-format` parameter; an unmapped or empty `--format`, `--format`
  without `--body-only`, and an answer without the requested representation
  fail on stderr with a non-zero exit. The brokers still write no file. Plain
  `get` is unchanged.
- A per-repository opt-out from the work-item key. The `commit-msg` hook skips
  the key check when the repository-local Git config
  `kherep.workItemRequired` is a Git boolean false (`false`, `no`, `off`,
  `0`). A non-empty `KHEREP_WORK_ITEM_REQUIRED` at commit time still wins,
  then the repository value, then the policy file. Global and system values
  do not opt out; an absent, unreadable or invalid value keeps the rule. AI
  attribution trailers are still rejected in an opted-out repository.

### Changed

- The Claude user settings now set `attribution` with an empty `commit`, an
  empty `pr` and `sessionUrl: false`, so Claude Code no longer instructs a
  `Co-Authored-By` trailer in commit messages or an attribution line in pull
  request descriptions. The object form is used because the shorthand
  `attribution: false` needs Claude Code 2.1.281 or later, and older versions
  discard the whole settings file. The existing commit guards are unchanged.
  Reinstall to apply.
- The retirement manifest `bootstrap/manifest/retired.txt` can now name
  workspace files with the `project/` prefix that the installer and
  drift-check already use. The installer parks such a file in a `_deprecated/`
  sibling inside the workspace, with its previous version in the installation
  backup under `retired/project/`, and a rollback puts it back. An entry that
  is absent on the host is skipped. drift-check reports a declared retired
  path that is still present, in the Claude home or in the workspace, as
  `RETIRED-LIVE` drift instead of passing, and the session-start drift nudge
  lists it. With `DRIFT_SCOPE=project` only the workspace entries are checked.

### Removed

- The MPAC tools (`modules/mpac-tools/`, Atlassian Marketplace vendor
  reporting). They are not part of Kherep's purpose. The installer no longer
  places `<workspace>/tools/mpac/` and drift-check no longer compares it;
  `KHEREP_INSTALL_ATLASSIAN_TOOLS` now gates only the Jira helpers. On hosts
  that installed them earlier, an upgrade parks `<workspace>/tools/mpac/mpac.ps1`
  and `README.md` in `<workspace>/tools/mpac/_deprecated/` through the
  retirement manifest.

### Fixed

- The session-start drift nudge lists drift-check findings labelled
  `MISSING-BLOCK`, `BLOCK-INVALID` and `NORMALIZE-FAIL`. It counted only
  `DRIFT`, `MISSING-REPO`, `MISSING-LIVE` and `EXTRA-LIVE`, so a report whose
  only problem carried one of the other labels ended in `FOUND DRIFT` but
  showed no findings at session start.
- The Claude hooks `cbm-code-discovery-gate`, `cbm-session-reminder` and
  `cbm-subagent-reminder` are executable again. They were tracked without the
  executable bit since 0.1.0, and because the settings invoke them directly,
  every installed host failed them with `permission denied` and the
  code-discovery gate and both reminders never ran. Reinstall to apply.
- The smoke test's project-drift assertion follows the managed-block rule from
  0.1.1: operator text outside the Kherep block in the workspace `CLAUDE.md`
  must not be reported as drift, and a change inside the block must be.
- The CLIs `bootstrap/confluence-space.mts`, `modules/twg/install.mts`,
  `modules/twg/runtime/cli.mts` and `modules/control-plane/node/cli.mts` run
  again when their path contains a symlink, such as the default macOS temporary
  directory under `/var`, which links to `/private/var`. They compared
  `import.meta.url` with the unresolved script argument, while Node loads the
  main module from its real path, so through a symlink they did nothing and
  exited 0. They now compare against the real path of the script argument.
  This does not rely on `import.meta.main`, which the Node 23 and early Node 24
  releases admitted by the engines range do not provide. The local-inference
  keepalive and runner tests now resolve their fixture directories to their
  real paths, and the runner test still removes its fixture afterwards. The
  local-inference check that rejects a symlinked output root is unchanged.

## [0.1.2] - 2026-09-24

### Added

- A `search` verb for the Confluence brokers. It runs a read-only semantic
  search filtered to the configured space and reports a hit, no match or an
  unavailable search as distinct exit codes (0, 1, 2).
- An evidence-first gate for Claude. A `UserPromptSubmit` hook asks for
  research on relevant prompts, naming the knowledge space and, inside a Git
  repository, the code graph. A `Stop` hook sends a substantial turn back once
  when it shows neither a lookup nor the visible classification
  `[research: none - <reason>]`. Trivial turns are not gated, a continuation
  is never blocked twice, and an unreadable transcript fails open. Skills
  listed in the optional operator file `<claude-home>/kherep/research-sources.json`
  count as lookups.

### Changed

- Codex observations no longer surface as a visible Stop continuation after a
  reinstall. Both hosts project an acceptance-only `Stop` group; the
  `UserPromptSubmit` Maestro context hook reminds the Maestro quietly to
  dispatch `codex-obs` once per main turn. Earlier managed Stop groups with an
  observation step are upgraded in place.

## [0.1.1] - 2026-09-24

### Added

- A commit policy file next to the `commit-msg` hook. The work-item rule now
  applies to every runtime that runs Git, not only to a process that carries
  the `KHEREP_*` variables. `KHEREP_WORK_ITEM_REQUIRED` and
  `KHEREP_WORK_ITEM_PATTERN` given at install time are persisted; a variable
  set at commit time still overrides the file.
- `labels --remove` for the Confluence brokers, with a read-back of the labels
  that remain on the page.

### Changed

- The installer manages only a marked reference block in the workspace
  `CLAUDE.md` and `AGENTS.md`. Text outside the block stays byte-identical;
  unedited copies of the previous full template are replaced by the block. The
  block points to the user-level rules instead of repeating them.
- The Confluence brokers and the modules they import are installed together
  with the observation agent. `KHEREP_INSTALL_ATLASSIAN_TOOLS` now only adds
  the Jira and MPAC helpers.
- The Claude observation agent has its own definition: it files through the
  Claude broker only, starts every result with an `OBS-RESULT` status line,
  keeps findings under a hierarchy node named in the brief and takes the
  session label from the brief. The Codex worker contract moved to
  `codex/agents/codex-obs.md`.
- The drift check compares only the managed block of the workspace rule files
  and includes the commit policy file.

## [0.1.0] - 2026-09-24

First public release.

### Added

- Maestro agent orchestration: plan work, delegate focused tasks and verify the
  combined result against code, tests and the requested outcome.
- Claude Code adapter with an installer that backs up and can roll back the
  managed configuration, an isolated preview mode and a read-only drift check.
- Codex adapter with its own installer, an installation receipt and the
  `kherep-maestro` plugin.
- Shared rules, hooks, skills and agents for implementation, review, debugging
  and delivery.
- Model and tool routing through operator-configured policies.
- MCP integration through transport and authentication adapters for explicitly
  configured services.
- Local inference through configured local processing routes, including a
  separate path for private inputs.
- Central Brain, a shared knowledge base in a dedicated Confluence space. The
  Claude and Codex observation agents file durable findings from completed
  turns as pages through the service-account brokers.
- Turn-completion observations for Claude and Codex through the service-account
  Confluence path.

[Unreleased]: https://github.com/cfaysal/kherep/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/cfaysal/kherep/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/cfaysal/kherep/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cfaysal/kherep/releases/tag/v0.1.0
