# Changelog

All notable changes to Kherep are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, a release that breaks a documented interface
increments the minor version; every other release increments the patch version.

## [Unreleased]

### Added

- Control Plane: the opt-in node policy switch `wake.replies: true` lets a
  reply wake the idle Claude Code session that sent the original message,
  without listing the session; `sessions` may then be empty. The grant needs
  the reply to come from the node the original was sent to, the original to
  be at most 24 hours old and not refused, expired or error, and the sending
  session's id, which `msg send` now keeps locally as `fromSessionId` and never
  sends to the Worker, to match (a sent record without it matches by name).
  Every other wake guard still applies; audit lines name `"grant": "reply"`,
  delivery progress reports such replies, and `doctor` shows the switch. A
  non-boolean value turns waking off. Codex wake paths are unchanged
  (issue #253).
- Control Plane: `GET /health` also returns the bundled product `version`,
  an optional deploy-time source `commit` (`--define KHEREP_BUILD_COMMIT`) and
  `remoteMcp`, still without authentication or configuration values. Existing
  fields are unchanged (issue #215).
- Control Plane: `kherep-node doctor` prints a JSON report on enrollment and
  key, daemon liveness, Worker reachability and version, policy and wake
  summary, installed runtimes and versions, hook paths against this checkout
  and live wake listeners, and exits 1 when a check fails. The daemon now
  writes `daemon.json` (pid, start, last authenticated connection and lost
  connection time) for it (issue #215).
- Control Plane: `kherep-node doctor` reports each runtime's `ready` from the
  daemon's last readiness probe instead of `"not available"`: `true`, or
  `false` with the fixed `cause` (`sign-in`, `timeout`, `error`), each with
  `probedAt` and `aged` (older than the daemon's 10 or 2 minute revalidation
  bound), or `"unknown"` when the daemon is not running or has not probed that
  runtime. Doctor never probes. A runtime the sessions policy names whose last
  probe needs a sign-in fails the `runtimes` check. The daemon records each
  completed probe in `daemon.json` as `readiness.<runtime>`, without the
  probe's output (issue #222).
- Control Plane: a runtime readiness probe (issue #197). `claude auth status`
  reported `loggedIn: true` for an expired login, so the node checks each
  enabled runtime with a real minimal call: `claude -p --safe-mode
  --no-session-persistence --tools ""` with a one-line system prompt, and
  `codex -c features.hooks=false exec --ephemeral --sandbox read-only` with the
  user's config, no hooks and its MCP servers disabled as for intercom runs. It probes once at daemon start;
  afterwards a verdict is used stale while it revalidates in the background
  (ready after 10 minutes, not ready after 2, also from the session round; 45
  second timeout), and no probe runs on the daemon's frame lane. A ready
  runtime is advertised as `runtime.claude.ready.v1` or
  `runtime.codex.ready.v1`. For a runtime that is not signed in, a task start
  or continue fails with `target runtime <runtime> not ready (sign-in
  required)` and starts nothing, and a message that a closed-session delivery
  or a Codex message resume would carry is `refused` with that reason instead
  of `delivered`. A probe that timed out or failed otherwise blocks no task;
  messages wait with `retry-pending`.
- Control Plane: a task or intercom run without first turn progress 10
  minutes after its start is stopped and reported `failed` with `no progress
  after start` (issue #197). The messages a Claude intercom run carried are
  refused with `target run made no progress after start`; those of a Codex run
  get the `wake-failed` progress and are offered again within the offer limit.
- Control Plane: `msg status` and `msg send --wait` show the sender states
  `running` and `stopped`, derived from the existing accepted progress codes
  without a new wire state, and an accepted message without progress for 5
  minutes gets a fixed actionable reason (issue #197). Messages for Codex task
  sessions now carry a progress code while the task is busy, stopped by its
  operator, held by a wake guard, failing to resume or running.
- Control Plane: the MCP `status` tool also returns `senderState` (`running`,
  `stopped` or the canonical state, from the same `senderState` function as
  `msg status`) and, for an accepted message without progress for 5 minutes,
  a fixed `hint` (issue #197). The `state` field is unchanged.
- Control Plane: a Codex intercom run the node started on its own is listed
  with `kind` `codex-intercom` instead of `codex-task`, so the MCP `sessions`
  tool tells it apart from a requested task; `msg sessions` marks both as
  `[background task]` (issue #198).
- Control Plane: an idle Claude Code session wakes after a restart without any
  user input (issue #101). A `SessionStart` input without `permission_mode`
  and without a stored mode now takes the mode of the last user entry in the
  session transcript (`transcript_path`, the last 2 MiB, only the
  `permissionMode` field, a regular file under `projects/` of the Claude
  config directory; `node/transcript-mode.mts`) and stores it. A missing,
  foreign or unreadable transcript, or `bypassPermissions` there, still
  refuses; the listing, settings and launch flag checks run as before. The
  listener armed there also wakes once, after 8 s, for messages that arrived
  while no listener ran (audit `backlog`), each at most once and under the
  same guards and budget; a prompt within those 8 s supersedes it.
- Control Plane: a message for a session of this node that is no longer
  running is still handled when the node policy sets
  `messaging.resumeClosed: true` (issue #102, default off). The daemon
  resumes the known session in the background in its recorded `auto` or
  `default` mode (Claude Code `claude --resume <id> --bg`, Codex
  `codex exec resume <thread>`) with the fixed wake text, so the message
  arrives as framed peer content, or otherwise starts an intercom session
  with the closed session's runtime and working directory and a directive
  that names the automatic fallback. The guards of `--new` and the wake apply
  fail closed (kill switch, sessions and runtime, `delegate.accept` and the
  accept rules, reply depth, never `bypassPermissions`, `maxConcurrent`,
  workspace roots, the session's turn budget), a message causes one attempt
  at most, and every outcome is audited in `wake.jsonl` as `closed-session`
  `resumed`, `new` or `refused` with the reason. Every successful listing is
  kept for 7 days in `known-sessions.json`.
- Control Plane: a message for a closed session goes to one intercom session
  per sender session instead of resuming the closed session, whose whole
  conversation a resume would reload (issue #105). The newest intercom session
  the node started itself for the same sender (`requestedBy`
  `<node id>/<session>`) gets it: a running one through its delivery hook and
  wake, the message readdressed to it (`closedTo` keeps the closed session)
  and its task grant extended to the messages of that sender; an ended one is
  resumed in the background (`claude --resume`, `codex exec resume`). Only
  without such a session, or when its resume fails, a new one starts. The
  closed session itself is no longer resumed. Every message now carries its
  threaded reply command: a new intercom session gets the messages framed as
  the delivery hook frames them, each with
  `<cli> msg send --reply-to <message id> -- <reply text>`, and is told to
  answer with it, as the hook and the Codex resume already frame it. The
  guards stay fail closed; the audit outcome `resumed` is replaced by
  `reused` (with the intercom session's `taskId`), next to `new` and
  `refused`.

- Control Plane: the Claude Code wake listener is armed at `SessionStart` too
  (issue #97), so an idle session is wakeable again after its process
  restarts (app restart, `--resume`, `--continue`, `/clear`, fork) without
  waiting for the user to type. The installer adds the entry last to the
  `SessionStart` hooks with the same `asyncRewake` and timeout. A following
  prompt supersedes that listener as before. After `compact` the session
  counts as busy, because auto-compaction runs inside a turn. A `SessionStart`
  input carries no `permission_mode`, so the listener arms there only when,
  fail closed, the mode the session's last prompt or `Stop` reported
  (`listeners/<id>.mode.json`) exists and is not `bypassPermissions`, the
  session is listed by id or name, no readable settings layer sets
  `defaultMode` `bypassPermissions`, and no launch flag of the owning Claude
  process points to bypass (`node/launch-mode.mts`). Anything it cannot read
  refuses with the audit `permission-mode-unknown`.

- Control Plane: `kherep-node attach <node>/<session>` resolves a session
  through the directory like `msg send` and prints the command to open it on
  its host (issue #81): `claude attach` and `claude logs` with the 8-character
  short id for a Claude Code background session, a note for an interactive
  one, and the thread title with `codex resume <thread id>` for Codex. An
  optional operator-written `attach.json` in the node's `control-plane`
  directory maps a node to an SSH target, which prefixes each command with
  `ssh -t <target>`; a session on this node gets no prefix. The command only
  prints; it runs nothing, opens no connection, and no session content
  travels through the Worker.

- Control Plane: `msg sessions` shows the Codex thread title the Codex app
  shows next to the session name, quoted, on the listing node and on peer
  nodes (issue #88). The daemon reads it from `session_index.jsonl` in the
  Codex home with a bounded, fail-soft read and publishes it as the optional
  session field `title`; the Worker stores it in a new nullable column.
  Titles are display only and never an address. Titles appear in the
  directory only after the Worker is deployed; older nodes and Workers
  ignore the field.

- Control Plane: the daemon wakes an idle interactive Codex session (TUI or
  app) for peer messages with `codex queue --thread <id> --message <pointer>`,
  a fixed text with the message count only; the woken turn's delivery hook
  offers the messages. The Claude wake's guards apply (kill switch, wake
  allowlist, no `bypassPermissions`, reply depth, shared budget), one queue per
  message, no second queue while one is unconfirmed, and never a flag that
  changes the sandbox or approvals. The Codex delivery hook records the
  session's permission mode; a session without one is woken only when the
  allowlist names it by its full id. `codex queue` runs on its own lane and is
  killed with its process tree after 30 seconds. Codex session names now use
  the random tail of the thread id (`codex-<last 8>`); the old prefix name is
  accepted only where it is unambiguous, and wake authorization uses the full
  id only. The Codex Stop continuation is budgeted and never runs in
  `bypassPermissions`.

- Control Plane Codex tasks: `POST /api/tasks` with `requirements.runtime`
  `codex` goes to a node that lists `codex` as a CLI runtime, and that node
  runs `codex exec --json` detached, with stdin from the null device, only
  when its `sessions.runtimes` lists `codex` (the default stays `claude`).
  Permission modes map to Codex sandboxes (`auto` and `acceptEdits` to
  `workspace-write`, `default` to `read-only`); the bypass flags are never
  passed. The task's session id is the `thread_id`; the node reports
  `started`, then `done` with the last message as summary or `failed`,
  continues with `codex exec resume`, and stops the process group by pid
  after checking its start time. Claude and Codex tasks share the limits.
  The Worker accepts runtime `codex` once redeployed. Codex task sessions are
  listed in the node's session snapshot from the task records (thread id,
  task name, runtime `codex`). A peer message for an ended Codex task resumes
  it with the message framed as the delivery hook frames it, under the Claude
  wake's guards (kill switch, allowlist or task grant, reply depth, budget),
  one run per task, and is confirmed when that run completes. The process can
  write the node's outbox (its only extra writable root) and gets
  `KHEREP_CONFIG_DIR` and `KHEREP_SESSION_ID`, so `msg send` works from the
  sandbox; the msg CLI honours `KHEREP_SESSION_ID` when
  `CLAUDE_CODE_SESSION_ID` is not set. The prompt goes to Codex on stdin, never as a
  process argument. A Codex task whose process cannot be identified after a
  daemon restart is reported failed (`process identity unknown`).

- Control Plane tasks: the operator creates a task with `POST /api/tasks`
  (behind Access), and the Worker dispatches `session.start` to an online node
  that advertises `sessions.v1` and matches the runtime, os and capabilities,
  the one with the fewest active tasks (409 with the reason when none fits).
  The node runs `claude --bg --name task-<id> --permission-mode <mode>` in a
  working directory inside its workspace roots, maps the session id from
  `claude agents --json --all`, reports state changes with `task.report`, and
  stops a session after its max runtime. `POST /api/tasks/{id}/stop` and
  `/continue` stop or resume it. Off unless the node's `policy.json` enables a
  `sessions` section; per node at most 3 running task sessions, 10 starts per
  rolling day and 120 minutes per run, permission mode `auto` by default,
  never `bypassPermissions`, Claude first (Codex: see the entry above). Sessions report
  with `kherep-node task done`, `msg send` tags messages with the task, and the
  wake listener wakes a task's session for messages of its task beyond the
  allowlist, within the budget. A session may request a task with `task new`
  only on the operator's directive and only when both nodes opt in
  (`sessions.delegate.request` and `.accept`); a session started for a task
  cannot request one. The audit records task actions, the requesting session
  and the directive, never the task text.

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

- Claude hooks: the six blocking guards move from JavaScript to TypeScript
  (`.mts`, ESM, Node type stripping), with their tests and
  `portable-scope-hooks.test`: `commit-guard`, `deploy-guard`,
  `dispatch-contract-guard`, `playwright-file-guard`, `privacy-boundary-guard`
  and `secret-output-guard`. Behaviour is unchanged; every existing guard test
  passes with the same count. `claude/hooks` holds no `.js` file any more and
  `legacy-javascript.txt` is empty. The settings template wires the `.mts`
  files, and `retired.txt` lists every old `.js`, so an install parks them in
  `hooks/_deprecated` and unwires every command that still runs one, including
  the legacy groups hosts carry under their own matchers. The Codex installer
  copies and wires the `.mts` names of `commit-guard`, `deploy-guard` and
  `playwright-file-guard`, removes their old `.js` copies (kept in the install
  backup) and recognises the block an earlier installer wrote with the `.js`
  names, so an upgrade replaces it instead of refusing. New tests run each of
  the six guards through its wired Claude command, and the three shared ones
  through their wired Codex command after an install, show that a 0-byte or
  missing guard fails those checks, and prove that each template matcher covers
  every tool a legacy matcher covered. Closes issue #237.
- Claude hooks: nine hooks move from JavaScript to TypeScript (`.mts`, ESM,
  run by Node's type stripping like the other `.mts` hooks), with their tests
  and `lib/semver-compare`: `clq-accept-gate`, `critical-file-integrity`,
  `drift-check-nudge`, `live-hook-integrity`, `maestro-banner-gate`,
  `maestro-discipline`, `orchestra-default`, `runtime-capability-snapshot` and
  `smoke-test-nudge`. Behaviour is unchanged. The settings template wires the
  `.mts` files; an install over an existing installation parks the old `.js`
  files in `hooks/_deprecated` through the install transaction
  (`retired.txt`), and the rendered settings keep only the `.mts` wiring. New
  tests run the two converted hooks that block, `clq-accept-gate` and
  `maestro-banner-gate`, through their wired settings command, and cover
  `critical-file-integrity`, which had no test. Part of issue #237; the
  remaining guards follow in a second batch.
- Control Plane: a message that a new Claude intercom session carries in its
  task text is `delivered` once the watch round sees that session's turn
  progress, no longer when `claude --bg` returns; until then it stays
  `accepted` with `fallback-running` (issue #197).
- **BREAKING** Control Plane: `msg send`, `msg send --new`, `msg inbox --from`
  and `msg sessions --from` no longer take `--from` as typed (issue #200).
  `--from` must name the session of `CLAUDE_CODE_SESSION_ID` or
  `KHEREP_SESSION_ID` by id or name, or be the full id of a Codex session a
  Kherep hook recorded within the last 12 hours, with no conflicting
  `KHEREP_SESSION_ID`. Refused with `is not a verified sender`, and nothing is
  written: an arbitrary name such as `--from ops`, a short `codex-<8>` alias, an
  id no hook recorded, and a record older than 12 hours. Call it correctly by
  omitting `--from` in Claude Code sessions and node-started Codex runs, or, in
  Codex, by passing the full session id the `SessionStart` hook context names
  (`msg send --from <session_id>`). A Claude Code variable that a Codex process
  inherited does not block its hook-recorded id. Missing-session errors now
  name both variables.
- Control Plane: `msg sessions` and the `msg send --new` result mark
  node-started background tasks and name the commands for their status and
  transcript (issue #198); `msg status` lists threaded replies (issue #200);
  new `msg stop` stops one task through owner task control and reports
  `stopped` only for a confirmed process-tree exit of the measured run
  (issue #199).
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

- Bootstrap: `install.sh` with a `CLAUDE_HOME` other than `<HOME>/.claude`
  no longer changes global or system `core.hooksPath` and no longer runs the
  credential step, which read the file named by an inherited
  `KHEREP_ATL_CRED_FILE_CLAUDE` (issue #256). A candidate run that forgot one
  skip switch had pointed the account's Git hooks at a temporary directory. A
  non-default home that is the real Claude home opts in per step with
  `KHEREP_INSTALL_ALLOW_GITCONFIG=1` and `KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL=1`.
  The new `KHEREP_INSTALL_PREVIEW=1` implies the Git configuration, runtime
  agent, credential and knowledge-space skips for any home, and the documented
  preview uses it. Each skipped step names its reason. The default-home install
  is unchanged.
- Bootstrap: an upgrade now unwires every `settings.json` hook command that
  runs a script listed in `bootstrap/manifest/retired.txt` (issue #252). A host
  could carry a second, legacy wiring such as `node ~/.claude/hooks/<name>.js`
  in groups of its own; the installer parked the file but left the command,
  which then failed with `Cannot find module` on every event. The settings
  render removes such a command from any event and group, whatever the spelling
  of the Claude home (the absolute path in drive or Git Bash form, quoted or
  not, and `~/.claude`, `$HOME/.claude` or `${HOME}/.claude` while
  `CLAUDE_HOME` is the default one; only `node <script>` commands are
  recognised), drops a group left
  without hooks, and prints one `retire: unwire <event> <command>` line per
  removal. Commands for scripts that are not retired, and commands that only
  name a retired file as an argument, stay. The new settings are written inside
  the install transaction, so a rollback restores the previous file.
  `drift-check.sh` now reports `DANGLING-HOOK <event> <command>` as drift for a
  wired command whose Claude-home script is missing or retired, under every
  `DRIFT_SCOPE`.
- Claude hooks: `clq-accept-gate.mts` is wired under `Stop` instead of
  `PreToolUse` `Bash`. It reads the Stop payload, and the only Stop wiring on
  existing hosts was the legacy `clq-accept-gate.js` entry that the upgrade
  above unwires. The settings render now also removes an entry the installer
  wrote for a managed hook (the hook under the absolute Claude home) at an event
  the template no longer wires that hook at, and prints
  `hooks: unwire <event> <command> (managed under <events>)`. Hand-written
  `~/.claude` entries and hooks the template does not manage stay.
- Control Plane: `kherep-node msg stop <messageId>` for a message delivered
  into an existing session no longer ends at the bare `not stopped: fresh
  status does not identify a stoppable run (denied, source_not_found)` (issue
  #241). Such a delivery starts no task, so the Worker holds no grant for the
  message. When the directory lists the message's target session under the
  task name of exactly one task this node requested on that node, `msg stop`
  stops that task through the existing fresh status and run-bound stop and says
  so; otherwise it names the target `<node>/<session>` and the message's
  progress and says the session matches no task the sender owns. No Worker or
  protocol change.
- Control Plane: the wake hook keeps its run mode per Claude Code process
  (issue #245), in `run-modes/<session_id>.<parent pid>.json` of the node
  directory for at most one hour and only for the same
  `CLAUDE_CODE_ENTRYPOINT`, so only the first hook of a process lists
  processes; read or write errors fall back to the full check. On macOS a kept
  decision took 0.02 to 0.03 ms instead of a median of 38 to 43 ms. Where a
  shell stays between Claude Code and the hook (Git Bash on Windows), every
  hook still checks in full. On macOS and Linux a `claude "daemon foo" -p`
  run, or a `claude -p` started by a session whose prompt begins with
  `daemon` but not `daemon run`, is no longer taken for the `--bg` daemon: its subcommands count
  only without `-p` or `--print` among the process's own options, and
  `daemon` only as `daemon run`. A `claude -p --resume` of an idle interactive
  session stays headless; the interactive session listens again from its next
  own prompt.
- Control Plane: a delegated task start the target refuses is no longer lost
  silently (issue #240). A Git Bash `msg send <mac> --new codex --cwd
  /Users/...` stored `C:/Program Files/Git/Users/...`; the Mac refused the
  start during admission without a log line or task record, and the sender
  saw `task_unknown` under a `dispatched` that never changed. Now the node
  logs every refused start (`task <taskId> refused: <reason>`) and every
  failed command result with its task id and reason, never the prompt. A start
  refused before a task record existed leaves a bounded record in
  `task-refusals/` (at most 256, 7 days) that only owner task control reads,
  so `task status` answers `taskState` `failed` with `processState` `closed`.
  A requesting node with owner task control advertises
  `sessions.own-task-control.report.v1`, and the Worker adds the state and
  reason of the target's last `task.report` as `reportedState` and
  `reportedReason`; older nodes and Workers never see them. `task show` says
  that `dispatched` means queued by the Worker, not acknowledged by the target,
  and shows the last status answer. `msg send <node> --new ... --cwd <dir>`
  refuses, before writing anything, a directory rewritten by Git Bash path
  conversion and, when the target's path style is known from its sessions in
  the directory, a Windows drive path for a POSIX node or the reverse; the
  error points to PowerShell or `MSYS_NO_PATHCONV=1`. The reported reason
  reaches the requester only after the Worker is deployed.
- Control Plane: a headless `claude -p` run no longer hangs until the wake
  hook's 24-hour timeout (issue #235). On Windows with Claude Code 2.1.289 the
  run waited for the wake listener, its only child process, and sent no API
  request. The listener still arms as before, so the arming order of a
  session's listeners is unchanged, but before its first poll it decides the
  run mode from one process listing. For a headless run it removes its own
  lock and scope (and the mode file this arming created), audits `headless`
  and exits 0. A process of the `--bg` machinery (`--bg-pty-host`, or the
  `daemon`, `bg-pty-host` and `bg-spare` subcommands on macOS) or its child,
  which includes the daemon's task and intercom sessions, is interactive; otherwise
  a run is headless when `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli` or when the
  first Claude Code process above the hook has the option `-p` or `--print`.
  Windows command lines are split with their quoting, so a `-p` in a quoted
  prompt does not count. Anything undecided keeps listening. Task sessions no
  longer inherit the daemon's `CLAUDE_CODE_ENTRYPOINT` and `CLAUDECODE`. On
  macOS and Linux, where `ps` loses the quoting, a session outside the `--bg`
  machinery whose prompt holds a separate `-p` is taken for headless.
- Control Plane: `msg status` no longer calls a policy refusal of
  closed-session delivery a failed delivery session (issue #230). A message
  for a closed session whose working directory lay outside the node's
  workspace roots read `the local delivery session failed; delivery is not
  confirmed [failed/fallback-failed]`, because the node guessed the progress
  code from the refusal text and fell back to `fallback-failed`. Each refusal
  now names its code: the working-directory checks, `delegate.accept` and an
  operator sender wait with `wake-not-authorized`, `maxConcurrent` and
  `maxStartsPerDay` before an attempt with `retry-pending`, and the start
  checks a new intercom session needs (its runtime and permission mode) are
  made before the attempt with their own codes. `fallback-failed` remains for
  a start or resume that failed, including a new start the policy refuses
  after a failed resume, since that message is not tried again; its reason
  names the policy (`new start refused: ...`). The
  `wake-not-authorized` text now reads `the target node's policy did not
  authorize automatic delivery`. No new progress code: older Workers accept
  every frame.
- Control Plane: a message for an ended Codex task whose working directory
  the node's policy refuses (not absolute, missing, or outside the workspace
  roots) no longer reads as a failed wake (issue #239). The exchange round's
  resume reported that refusal as `failed/wake-failed`; it now waits with
  `waiting/wake-not-authorized`, the code closed-session delivery uses for the
  same check since issue #230, and the next round tries again. `wake-failed`
  remains for a resume that did not start. No new progress code: older
  Workers accept every frame.
- Control Plane: a message for an ended Codex task no longer stays
  `accepted` without a progress code while the node's policy has sessions not
  enabled or `codex` missing from `sessions.runtimes` (issue #244). The
  exchange round now labels it `waiting/wake-disabled` and audits `disabled`
  once per message, as under the kill switch; nothing starts. A refused
  working directory keeps `waiting/wake-not-authorized`, audits the new
  action `cwd-refused`, and logs `not resuming task <taskId> for messages:
  <reason>` once per message instead of on every 2-second round. No new
  progress code: older Workers accept every frame.
- Control Plane: a Codex run whose `codex exec` process dies abruptly no
  longer leaves its shell commands running (issue #233). On macOS a
  `sleep 901` outlived a SIGKILLed Codex intercom run in its own process
  group, re-parented to init; the run settled `failed` and `msg stop` found no
  running process. The watch round now records a live run's descendant
  processes with their start identities in the task record (at most 32, a
  start read only for a pid not recorded yet), and when the run settles
  `failed` after its root ended, or a stop finds the root already ended, it
  ends each recorded descendant that still has its recorded start identity by
  its own pid, SIGTERM and then SIGKILL, off the frame lane, and logs the pids.
  A reused pid is never signalled; a run that settles `done` keeps what it
  started.
- Control Plane: a task stop no longer leaves a Codex shell command running
  when it is outside the root's process group (issue #231). On macOS a
  `sleep 900` started by Codex missed the SIGTERM to the root's group, Codex
  exited, and the stop failed with "root process ended before SIGKILL while
  captured descendants still run" without ever signalling the child, which
  then ran on as an orphan. After each group signal, SIGTERM and then SIGKILL,
  the stop now signals every captured descendant that still has its captured
  start identity by its own pid (`taskkill /PID <pid>`, `/F` for SIGKILL, on
  Windows, where `taskkill /T` cannot reach a descendant whose root ended),
  also when the root has already ended. A reused pid is never signalled, the
  group is signalled only while the root is the captured process, and the
  stop is still confirmed only after every captured identity ended; otherwise
  it fails and names the ended or reused root and any failed SIGKILL send. A
  failed SIGTERM send no longer ends the stop before SIGKILL.
- Control Plane: the daemon removes the locks of wake listeners whose process
  is gone, at its start and then hourly, so doctor's `stale` listener count
  falls (issue #225). It never deletes by path: it renames a lock to a
  tombstone, deletes it only when its bytes still equal what it judged, and
  otherwise links it back without overwriting; if a file took the place
  meanwhile, the later-armed lock keeps it, by a clock-independent arming
  `order` (one more than the lock and scope in place at least; `startedAt`
  stays real time). A listener never yields
  to an older one: it puts its lock back when it is gone and the scope file
  names it or an older listener (the scope now records `order`), and
  writes it back over an older listener's lock. The scope file goes with its
  lock only while it carries that lock's token; the session's mode, budget,
  woken and queued files stay. Sweep failures are logged with their error codes,
  and a lock or scope read that fails is never taken for a missing file.
- Control Plane: a task stop no longer leaves the process tree running when a
  helper times out (issue #221). On a `windows-latest` runner the Toolhelp32
  process-tree query (`powershell.exe` with an `Add-Type` compile) hit its
  10 s limit, the stop threw before any signal, and the deadline test waited
  in vain for the tree to end. A query that timed out now runs once more.
  When a `ps` or PowerShell helper of the stop still times out, the stop
  forces the tree of the root if the root still has its recorded start
  identity (SIGKILL, `taskkill /T /F` on Windows) and still fails with the
  timeout, so the failure is logged and no unconfirmed stop is reported; a
  later watch round settles the task as an ended run. Any other failure is
  unchanged.
- Control Plane: on Windows a credential write or ACL check whose
  `powershell.exe` run hits its 5 s limit runs once more instead of failing
  with `remote_mcp_credential_unreadable` (issue #219). On loaded
  `windows-latest` runners the first start in a test exceeded the limit in
  three runs on 2026-10-04, while the write, its check and one bridge check
  took 0.9 to 3.3 s together in 14 passing runs. The writer removes the
  timed-out attempt's temporary file first; any other failure and a second
  timeout still fail closed.
- Control Plane: an outbox message the Worker did not answer is sent again on
  the live connection after 30 seconds instead of waiting for a reconnect, and
  inbox retention refuses a waiting message instead of deleting it unreported
  (issue #195). Regression tests cover a lost answer, a repeated send and a
  crash of either daemon in the middle of an exchange.
- Control Plane: operator Codex tasks (start and continue) no longer open
  visible console windows on Windows and still survive a daemon restart
  (issue #124). The daemon starts them detached through a small wrapper,
  `node/codex-windowless.mts`, run with its own Node: codex runs as the
  wrapper's attached child with all stdio piped, so Node starts it with
  `CREATE_NO_WINDOW` and its shells and MCP servers share a console without
  a window. The wrapper forwards the prompt, the events, stderr and codex's
  exit code; the pid, start time and `exit.json` the daemon records are the
  wrapper's, and `taskkill /T` on it ends codex and its children. Intercom
  runs and macOS and Linux are unchanged. `conhost.exe --headless` was
  measured and rejected: codex's stdout arrives as terminal escape sequences,
  the console host ends when its input closes and exits 0 whatever the exit
  code of codex.
- Control Plane: finished Codex tasks settle on Windows (issue #121). The
  start-time query exited 1 for a pid that had ended, so the watch took an
  ended process for a failed read: the task stayed `started`, the messages
  its run carried stayed `offered`, and `could not stop task ...` repeated in
  the daemon log. The query now returns no output and exit 0 only for "no
  such process" and still fails for any other error. A run whose `exit.json`
  the daemon recorded counts as ended without a start-time read, also past
  its deadline, and is not signalled on stop; tasks already stuck `started`
  with an `exit.json` settle on the first watch round after the upgrade.
- Control Plane: daemon-started Codex intercom runs no longer open visible
  console windows on Windows (part of issue #119). They start without
  `detached` there and share the daemon's hidden console; operator Codex
  tasks and other platforms stay detached. Such a run ends with the daemon,
  so the messages of a new Codex intercom session now wait for it `offered`
  and count as `delivered` only when its run completes the turn; a run a
  daemon restart ended offers them again and the next exchange round resumes
  the session for them.
- Control Plane: daemon-started Codex intercom runs no longer start the MCP
  servers of the user's Codex config (issue #119, `node/codex-mcp.mts`). The
  run still loads that config, so its hooks and guards keep working, but gets
  one `-c mcp_servers.<name>.enabled=false` per enabled server the config
  defines, before `exec` (also for `exec resume`). The names come from
  `codex mcp list --json`, run by the daemon without a shell; only bare key
  names are used, and the overrides are checked once with
  `codex <overrides> mcp list --json`, dropping each server codex rejects
  (servers the desktop app or a plugin provides, which make codex fail at
  startup when overridden). The result is cached per codex binary for
  5 minutes. When the list cannot be determined the run starts as before and
  the daemon log names the reason. Operator Codex tasks are unchanged.
  Measured on Windows with Codex CLI 0.157.1: 10 of 11 enabled servers
  disabled, local descendant processes of a probe run 22 before, 10 after,
  with the app-provided `cua_repl` the only MCP server left.
- Adopting a resumed intercom session as a copy no longer leaves the previous
  copy running (issue #111). The intercom task record notes the session it
  held before the resume (`retire`); once the new copy is adopted, right after
  the resume or in a later watch round, the node stops the previous one with
  `claude stop <short id>`, but only while `claude agents --json --all` lists
  it under that short id with the recorded session id and `status` `idle`. A
  `busy` or `waiting` one is tried again in each watch round, up to 30 rounds;
  one that is not listed, holds another session id or has no live process is
  left alone. Only sessions a node-started intercom record held are stopped,
  never the closed session the messages were sent to. `wake.jsonl` records
  each stop with the action `closed-session` and the outcome `retired-copy`,
  and a give-up with `copy-kept`.
- A message for a closed session that its intercom session answered is no
  longer refused as `target session not running` (issue #111). The copy's
  first turn could start before the node readdressed the message to it, so no
  turn offered it; the session read it with `msg inbox`, answered with
  `msg send --reply-to`, and the record stayed `accepted` until the copy
  ended and the 60-minute sweep refused it. A reply now marks the waiting
  message it answers as `delivered`. The sweep also judges a message handed to
  an intercom session (`closedTo` set) by its current `toSession` from the
  time of the handover (`closedAttempt`), not from its arrival.
- A node-started Claude Code session whose wake listener armed before the node
  recorded its session id is woken again (issue #109). This happens after a
  resume that Claude Code continued as a copy under a new id. The node now
  writes the task record before `claude --bg` or `claude --resume --bg` with
  `mappingPendingSince`, maps the session through `claude agents --json`
  right after the run, and clears the field once the id is listed. A resumed
  intercom session that became a copy is adopted: the same task record takes
  the new id and its waiting messages are readdressed to it, instead of
  stopping the copy and starting a new intercom session. A wake listener
  without grant or allowlist entry keeps polling while an active task record
  in its working directory has had a pending mapping for at most 2 minutes,
  and wakes once the node records its id. The grant still comes only from
  that recorded id. Otherwise the listener exits at once with
  `not-allowlisted` as before, audited once.

- `msg send <node>/<full session id>` reaches a closed session (issue #107).
  A full session id (a UUID, as Claude Code and Codex use) on a node the
  directory lists as `online` is now sent even when the directory no longer
  lists that session, with the note `session not listed on <node>; the node
  decides whether it can deliver` on stderr. The target node decides as for
  any message: its accept rules, then delivery, the closed-session fallback
  (`messaging.resumeClosed`), or the refusal after 60 minutes. Names, labels,
  `codex-<8>` and titles still need a listed session, an unknown node or a
  node that is not online still fails, and `attach` is unchanged.
- Windows installation with Claude Code installed through npm (issue #99): the
  plugin reconciliation no longer fails with `Claude marketplace list failed`
  when only the npm `claude`/`claude.cmd` shims are on `PATH`. Without
  `KHEREP_CLAUDE_BIN` it runs the first `claude.exe` on `PATH` or the native
  `bin/claude.exe` next to an npm shim, still without a shell, and fails naming
  `KHEREP_CLAUDE_BIN` when neither exists. The installer no longer warns that
  the global `core.hooksPath` is being replaced when the old value names the
  same directory in another Windows spelling, and the repository-local binding
  skips repositories under `_deprecated`.
- Codex sessions send and reply over the Control Plane on the first try
  (issue #72): the Codex installer makes the node outbox, and only the outbox,
  a writable root of the `workspace-write` sandbox
  (`sandbox_workspace_write.writable_roots`). Without a table of the operator's
  the managed block carries it; an operator table or dotted keys get the
  outbox merged into their `writable_roots`, never a second table and never a
  removed entry; an inline table or `default_permissions` is left alone. The
  receipt reports the outcome. `node onboard` and the daemon create the outbox,
  because a sandboxed session can write into it but not create it.
- Control Plane Codex tasks run in a workspace root that is not a Git
  repository: `codex exec` and `codex exec resume` get `--skip-git-repo-check`
  (the sandbox is unchanged). A failed run reports codex's last stderr line
  after the exit code, with API keys redacted. On Windows a `codex.cmd` npm
  shim is no longer refused: the node runs the package's launcher
  `bin/codex.js` with its own Node and without a shell, and a stop ends the
  whole process tree. A continue or message resume checks the task's working
  directory against the workspace roots again, a thread id must be a plain id,
  and failure reasons also redact bearer tokens, JWTs, URL user info and query
  strings. Codex on Windows stays unmeasured: its sandbox must be checked before
  a Windows node lists `codex`.

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
