# Changelog

All notable changes to Kherep are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, a release that breaks a documented interface
increments the minor version; every other release increments the patch version.

## [Unreleased]

### Added

- Control Plane: an idle Claude Code session wakes when a peer message
  arrives, if the node's `policy.json` opts in with a `wake` section that
  lists the session (by id or name, or an explicit `"*"`); without it nothing
  is woken. A listener (`modules/control-plane/node/wake-hook.mts`) runs with
  `asyncRewake` after the delivery hook on `UserPromptSubmit` and `Stop`, one
  per session, and takes its re-arm deadline from the `--timeout` its entry
  carries. Wakes and `Stop` continuations share a budget of 6 per rolling
  hour, 20 per rolling day and 30 s spacing per session; a session in
  `bypassPermissions` is neither woken nor continued. It does not wake at reply
  depth 6 or deeper, wakes once for an offer left by a turn without `Stop`,
  ends when its Claude Code process is gone, re-arms itself before its timeout,
  and can be switched off with a `wake.disabled` file in the node directory;
  every decision is logged to `wake.jsonl` without message text. A prompt typed
  while a turn is still running no longer re-offers that turn's messages; they
  are re-offered after `StopFailure` (now wired) or after 10 minutes. `msg
  send` addresses sessions by id, policy rules match the id or the session's
  current name, and the peer framing follows the new peer-coordination rule.
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
- The Claude installer wires the control-plane delivery hook
  (`modules/control-plane/node/deliver-hook.mts`) into the `UserPromptSubmit`
  and `Stop` hooks of the user `settings.json`. It runs from the Kherep
  checkout through the new `__KHEREP_REPO__` placeholder, rendered with
  forward slashes and quoted like the other hook paths; `drift-check.sh`
  renders the same path and `capture.sh` maps it back. Without an enrolled
  node the hook finds no inbox and exits 0 without output.
- Control Plane Codex sessions (issue #31, step 4). The delivery hook takes
  `--runtime codex` and then serves Codex `SessionStart`, `UserPromptSubmit`
  and `Stop`: it records each session in `codex-sessions/`, tells the session
  its id at start, offers messages as developer context with a `--from` reply
  command, and at `Stop` continues the turn with a fixed text, never peer
  content, when new messages wait. The daemon lists Codex sessions seen within
  12 hours, `msg send --from <codex id>` sends as the session's name, and the
  Codex installer adds the three hooks to its managed block. The hooks must be
  trusted in Codex before they run.

### Changed

- The Claude user settings now set `attribution` with an empty `commit`, an
  empty `pr` and `sessionUrl: false`, so Claude Code no longer instructs a
  `Co-Authored-By` trailer in commit messages or an attribution line in pull
  request descriptions. The object form is used because the shorthand
  `attribution: false` needs Claude Code 2.1.281 or later, and older versions
  discard the whole settings file. The existing commit guards are unchanged.
  Reinstall to apply.
- `engines` in `package.json` is now `^22.18.0 || >=23.6.0`. Node 23.0 to 23.5
  cannot run the TypeScript sources without a flag; unflagged type stripping
  arrived in Node 23.6.0.
- The retirement manifest `bootstrap/manifest/retired.txt` can now name
  workspace files with the `project/` prefix that the installer and
  drift-check already use. Such an entry lists the SHA-256 of every version
  the installer placed there, hashed with CRLF folded to LF
  (`project/<path> sha256:<hex>[,<hex>...]`), and an entry without hashes is
  rejected when the manifest is read. The installer parks the file in a
  `_deprecated/` sibling inside the workspace only while its content matches
  one of those hashes, with its previous version in the installation backup
  under `retired/project/`, and a rollback puts it back. Other content is
  kept in place and reported as
  `retire: KEEP <entry> (content not placed by the installer)`, without a
  backup or journal entry, and the installation continues (#45). An entry that
  is absent on the host is skipped. A `_deprecated/` directory the pass
  creates is journalled, and a rollback removes it again while it is empty.
  drift-check reports a declared retired path that is still present, in the
  Claude home or in the workspace, as `RETIRED-LIVE`. The line is information:
  it does not change a PASS or the exit code, and the session-start drift
  nudge does not count it (#45). With `DRIFT_SCOPE=project` only the workspace
  entries are checked.
- The Codex installer retires workspace files through the same
  `bootstrap/manifest/retired.txt` and the same rules as the Claude installer
  (#44). It reads the `project/` entries, ignores the Claude-home entries,
  refuses the whole manifest before anything moves when an entry is invalid,
  and parks a file in a `_deprecated/` sibling only while its content matches
  one of the listed hashes; other content is kept and reported as
  `retire: KEEP <entry> (content not placed by the installer)`. A parked file
  has its previous version in the installation backup under `workspace/`, an
  occupied destination gets a dated suffix, and a rollback puts the file back
  and removes a `_deprecated/` it created while that is empty. Retirement now
  runs on every Codex install, also without `KHEREP_INSTALL_ATLASSIAN_TOOLS=1`.
  The installer no longer deletes the old `tools/*.mjs` Jira brokers from its
  own hardcoded list: six of them are now declared in `retired.txt` with the
  hashes of the versions the installer placed, so both installers park them.
  `tools/jira-config.mjs` has no known placed version and is no longer
  retired automatically.
- The Claude installer writes the system-wide `core.hooksPath`, which binds
  every account on the host, only with `KHEREP_INSTALL_SYSTEM_HOOKSPATH=1`.
  Without it the installer reads the value and, when it differs from Kherep's
  hook directory or is unset, prints both values and changes nothing, even when
  the system file is writable without elevation, as it can be with Git for
  Windows. With it the installer reports the value it replaced, and a failed
  write fails the install. The global and repository-local bindings are
  unchanged.

### Removed

- The MPAC tools (`modules/mpac-tools/`, Atlassian Marketplace vendor
  reporting). They are not part of Kherep's purpose. The installer no longer
  places `<workspace>/tools/mpac/` and drift-check no longer compares it;
  `KHEREP_INSTALL_ATLASSIAN_TOOLS` now gates only the Jira helpers. On hosts
  that installed them earlier, an upgrade parks `<workspace>/tools/mpac/mpac.ps1`
  and `README.md` in `<workspace>/tools/mpac/_deprecated/` through the
  retirement manifest.

### Fixed

- Two Codex installer failures (#55). The installer parses only the standard
  output of `codex plugin marketplace list --json`; the warning Codex prints on
  standard error when `CODEX_HOME` lies under a temporary directory made the
  joined output invalid JSON and stopped the install with `Unexpected Codex
  marketplace list schema`. And after `brew upgrade node` on macOS, a managed
  block whose hook commands name the removed versioned Node keg is recognised
  again: the known managed fragments are also matched as rendered with each
  Node path the live block names, still exactly, and a `notify` entry with that
  path is removed as before. Any other difference is still refused. New
  renders name the Homebrew link `<prefix>/bin/node` instead of the keg under
  `<prefix>/Cellar/node/<version>` when the link resolves to the running
  executable, so the next upgrade does not invalidate the block. An explicit
  `nodePath` still wins. Reinstall to apply.
- The session-start drift nudge lists drift-check findings labelled
  `MISSING-BLOCK`, `BLOCK-INVALID` and `NORMALIZE-FAIL`. It counted only
  `DRIFT`, `MISSING-REPO`, `MISSING-LIVE` and `EXTRA-LIVE`, so a report whose
  only problem carried one of the other labels ended in `FOUND DRIFT` but
  showed no findings at session start.
- `bootstrap/install-transaction.test.sh` can no longer change the host's Git
  configuration. Whatever the caller's environment, it redirects the system
  and global scopes to throwaway files, drops every inherited `KHEREP_*`
  variable, and fails when the host's system or global `core.hooksPath`
  differs after the run.
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
- The remaining entry points and hooks no longer rely on `import.meta.main`
  to detect a direct start. Node 23.6 and later 23 releases and Node 24.0 to
  24.1 run the TypeScript sources but lack it, although the engines range
  admitted them, so there eight Claude hooks, ten Codex hooks, including the
  privacy-boundary and dispatch-contract guards, and the bootstrap, Codex
  installer, plugin-snapshot, broker, local-inference and MCP-wrapper CLIs did
  nothing and exited 0. Node 23.0 to 23.5 failed loudly instead, because they
  cannot load the sources without a flag. Every entry point, the four CLIs
  above included, now compares `import.meta.url` with its script argument both
  as given and resolved to its real path, so it also runs under
  `--preserve-symlinks-main`, which keeps the symlinked path. A test fails when
  a tracked source file reads `import.meta.main` again, compares against the
  script argument in one form only, or defines the check without both forms,
  and CI runs the unit, Codex, module, broker and Control Plane node suites on
  Node 22.18.0 and 24.1.0.

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
