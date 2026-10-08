# Changelog

All notable changes to Kherep are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, a release that breaks a documented interface
increments the minor version; every other release increments the patch version.

## [Unreleased]

### Added

- Main-checkout guard: a new `PreToolUse` hook, `main-checkout-guard.mts`,
  keeps the main checkout of a workspace repository (git-dir equals
  common-dir) on its default branch, because sessions share it. It blocks
  `git checkout <ref>` without `--` (a SHA included), `checkout -b`, `-B`,
  `--orphan`, `--detach`, and `git switch` to any branch other than the
  default, including `-c`, `-C` and `--detach`, with exit 2 and a pointer to
  `git worktree add <path> -b <branch>`. File checkouts, `restore`,
  `worktree add`, `pull`, `fetch`, `merge`, `rebase`, linked worktrees and
  repositories outside the workspace pass. The default branch is
  `origin/HEAD`, else a local `main` or `master`; without one it warns and
  exits 0. The inline `KHEREP_MAIN_CHECKOUT=switch` prefix, or
  `$env:KHEREP_MAIN_CHECKOUT='switch';` in PowerShell, lets one approved
  command through; a persistent variable is ignored. Claude runs it for Bash
  and PowerShell in a new `Bash|PowerShell` group; Codex runs it through the
  hook adapter as the last entry of the shell group, so a block arrives as a
  JSON deny. A new git `post-checkout` hook beside `commit-msg` warns, and
  always exits 0, when a branch checkout leaves such a main checkout off its
  default branch; it is silent in linked worktrees, after `worktree add`,
  during a rebase and with the marker. `critical-file-integrity.mts` guards it
  like `commit-msg` (issue #325).
- Confluence brokers: new read-only verb `list --space <key>
  [--title-contains <text>] [--label <name>] [--limit <n>]`. It reads every
  page of the space through the paginated v2 pages endpoint, filters titles by
  case-insensitive substring in the broker, and filters by label through one
  v1 CQL query that follows `_links.next`. It prints one `page` row per match,
  then `total:`, `shown:` and `truncated:`. The total is counted by reading
  every result page, never taken from `totalSize`; only `--limit` truncates.
  Exit 0 for any completed read, including `total: 0`, and exit 1 for a
  Confluence or argument error, which prints no `total:`. The space index now
  stops on a cursor that adds no new page, not only on an empty page
  (issue #315).
- Confluence brokers: `labels --id <page> --keep-runtime <runtime-label>`
  repairs a page that carries two runtime labels. It deletes the other one,
  reads the labels back and prints `runtime: kept`, `runtime: removed` and
  `labels:`; it exits 1 when the removed label is still there. It cannot be
  combined with `--labels` or `--remove`, and it refuses without writing when
  the value is not a `runtime-` label, when the page carries one, none or more
  than two runtime labels, or when the named label is not among them. The
  `labels` verb now lives in the shared `confluence-label-cli.mts`, which the
  installers, drift checks and smoke test project beside the brokers
  (issue #318).

### Changed

- Control plane Worker: a message is deleted once its sender acknowledged the
  final status (`message.status.ack`, `delivered`, `replied`, `refused` or
  `expired`). The acknowledgement must come from the sending node and name the
  stored final state; a repeat is a no-op. Messages from the operator API and
  from senders without `messaging.ack.v1` are deleted 24 hours after their
  final state, and a revoked node's final messages at once; `queued` and
  `accepted` messages are never deleted. A 24-hour tombstone (ids, nodes,
  final state, reason, reply depth, reply id; no text, no sessions) answers a
  late resend, a late target report, MCP `status` and task-control
  provenance. The Worker now stores every message's reply depth and refuses a
  reply beyond `MAX_REPLY_DEPTH` with `reply depth exceeded`. An MCP `reply`
  to a deleted message reads that one item from the replying node's inbox
  (`mcp.inbox.request` with `messageId` and `reply`; the node marks it
  answered); an older node fails it closed. Messages stored before this
  deploy are never deleted, whatever acknowledgements, replays or revocations
  reach them. `GET /api/messages` no longer lists acknowledged messages; the
  audit keeps their history without text. All new queries are index-backed
  and covered by the read-budget test (issue #308, PR 4 of 4).
- Atlassian MCP: Kherep targets the v2 Atlassian remote MCP server. The Claude
  capability check no longer expects a `rovo` server. With the optional
  Atlassian tool set the Codex installer writes the managed MCP server
  `atlassian` (`https://mcp.atlassian.com/v2/mcp`) instead of registering the
  legacy `atlassian-rovo@openai-curated` plugin, retires the v1 `rovo` table,
  and recognises a managed block an earlier installer wrote with or without
  that `rovo` table; tables outside the block stay untouched. The install
  receipt drops `nativePlugins`. The research-evidence matchers count the v2
  `searchConfluence` tool under any server name, including a claude.ai
  connector named by a UUID (issue #304).

### Fixed

- Deploy guard: the force-push rule only counts a force flag in the
  arguments of the same `git push`. Before, it matched `git push` and a force
  flag anywhere in the command, so `gh api … -f body=x && git push origin
  feat`, `git push origin main && npm cache clean --force`, `grep -f … && echo
  'see git push docs'` and a broker call whose quoted page text mentioned
  `git push` next to its own `-f` were blocked. It now also blocks force
  pushes it let through: `git -C <dir> push -f`, `git -c k=v push -f`,
  `git --git-dir … push -f`, `git push -fu`, `git push origin +main`,
  `+HEAD:main` and `--force-with-lease=` with an empty value.
  `--force-if-includes` alone and `-f` after `--` stay allowed. The new
  `hooks/lib/git-push-match.mts` splits the command into simple commands in
  one linear pass, scans quoted words and heredoc bodies again as shell down
  to depth 3, and when it cannot parse the command it falls back to the old
  regexes, so the rule still fails closed. The installer manifest lists the
  new module (issue #327).
- Confluence brokers: `labels --id <page>` without `--labels` or `--remove`
  is read-only. It sends one GET and prints `labels: a, b` or `labels: none`.
  Before, it posted the computed runtime label, so reading a page from a
  second host gave it a second runtime label. `labels --labels` reads the page
  first: an existing runtime label is kept (`runtime: kept <label>`) and only a
  page without one gets the computed label (`runtime: added <label>`); when
  nothing but a runtime label would be added to such a page, it refuses with
  exit 1 and writes nothing. `create` gives every new page the computed
  runtime label, also without `--labels`; before, a page created without
  `--labels` carried none. When that label write fails, `create` exits 1 and
  names the page that now exists without a runtime label (issue #318).
- Confluence brokers: `search` passes `--limit` to the semantic search as
  `min(max(limit, 25), 100)`, where 100 is the `twg rovo search` maximum.
  Before, the limit never reached it and every search asked for the default
  25 proposals. After the hits it prints `truncated: true|false`; true means
  `--limit` cut off a further matching page, the proposals filled the request,
  or `--limit` was above 100. Exit codes are unchanged (issue #315).
- Control plane node: `delivered` is a read receipt on every path. The
  messages a new Claude intercom session carries in its task text are offered
  to it and become `delivered` only once its turn completed (the session
  `done` in the watch round, or its own `Stop`); before, a session still
  `working` 30 seconds after its start already counted. A failed or stopped
  turn offers them again. The records an MCP `inbox` read returns are offered,
  so a reply or the session's `Stop` confirms them; a read that does not fit
  the transport offers nothing, and `StopFailure` stays no receipt. The node
  answers every final `message.status` it recorded (`delivered`, `replied`,
  `refused`, `expired`), also for a message without a local `sent/` record,
  with the event `message.status.ack`, and advertises `messaging.ack.v1`. An
  older Worker ignores the event (issue #308, PR 3 of 4).
- Control plane node: outbox resends and inbox status re-reports back off on a
  live connection. The first resend still comes exactly 30 seconds after the
  first send, later ones wait with equal jitter up to 10 minutes; a status is
  reported at once for each new state or progress and then on the same
  schedule. The schedule starts over after the Worker answers and on every new
  connection. `directory.request` bursts from the `msg` CLI are coalesced to
  at most one directory request per 10 seconds per connection. Before, every
  unanswered status was re-sent on each 2-second exchange round (issue #308,
  PR 2 of 4).
- Control plane Worker: a message send, a status report and a sender's
  reconnect replay no longer scan the whole `messages` table, which keeps every
  final-state row. Two additive indexes (`messages_queued_expiry`,
  `messages_from_node`) serve the hot queries, which name them with
  `INDEXED BY`; a third, `messages_state_updated`, is created for a later
  sweep of final-state rows and is not read yet. With 2,000 final-state
  messages a send now reads 4 rows instead of 4,009, a status report 5 instead
  of 2,008, and the cost no longer grows with the table. The Registry caches the directory rows until a
  write to nodes, runtimes or sessions. A new SQL meter logs one
  `registry.sql` line with `path`, `rowsRead` and `rowsWritten` per Registry
  request, without message text, and the committed `wrangler.jsonc` and the
  README override example turn on Workers Logs; it takes effect with the
  operator's next deploy (issue #308, PR 1 of 4).
- Bootstrap: `drift-check.sh` compares the optional Jira helpers in
  `<workspace>/tools/` when `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is set or when
  any of the twelve exact file names is present. Before, it compared them only
  with the switch, so a stale `atl-jira.mts` from an earlier installation with
  the switch passed as clean. A stale file is now `DRIFT` and the absent members
  of an incomplete set are `MISSING-LIVE`. Without the switch and without any of
  these files the check still passes and prints one informational
  `NOT-INSTALLED project/tools/<Jira set>` line. Look-alikes such as
  `atl-jira.mjs`, `*.bak-*` copies and `_deprecated/` never count as present
  (issue #302).
- Session observations: the brief marks each finding `measured:`, with the
  command and the deciding output excerpt, when the dispatching session ran it
  in this turn, and `relayed:`, with its source, otherwise. `claude-obs` and
  `codex-obs` label a `measured:` finding with that evidence `confirmed` and
  put the command and excerpt in the page body; a `relayed:` finding, a
  `measured:` one without evidence, or an unmarked one stays `assumed`. The
  origin line names the actual reporter, a title says "(operator-reported)"
  only when the operator is the source, and the dispatching session is never
  called the operator. Before, findings the dispatching session had measured
  in the same turn were filed as assumed and operator-reported. Both
  `ROUTING.md` files and the three observation hook reasons state the brief
  contract (issue #309).

## [0.2.0] - 2026-10-07

### Added

- Control Plane: with `wake.replies: true` the messages of a task an idle
  Claude Code session requested with `msg send <node> --new` also wake it
  without a listing, so the task's plain `msg send` answer, which carries the
  task id and no `inReplyTo`, is not left waiting for the next user turn. The
  grant needs the request to be dispatched, the message to come from the node
  the task was dispatched to, the request to be at most 24 hours old, and the
  requesting session's id, which `msg send --new` and `task new` now keep locally as
  `requestedBySessionId` and never sends to the Worker, to match (a request
  without it matches by `requestedBy`). It covers every message of the task,
  bounded by the turn budget. Audit lines name `"grant": "task"`, delivery
  progress reports such messages like replies, and Codex requesters are out
  of scope (issue #264).
- Control Plane: the optional node policy object `wake.budget`
  (`perHour`, `perDay`, `spacingSeconds`) sets the per-session budget of
  autonomous turns, which stays 6 per rolling hour, 20 per rolling day and
  30 s apart without it or for a missing field. Values must be integers within
  hard bounds (`perHour` 1 to 60, `perDay` 1 to 500, `spacingSeconds` 5 to
  3600), an explicit `perDay` at least `perHour` (without it the day allows at least `perHour` turns); anything else, or an unknown key,
  rejects the whole `wake` section. The Claude Code wake listener, the Claude
  and Codex `Stop` continuations, the Codex task resume, `codex queue` and
  closed-session delivery use the same effective budget, and `doctor` shows it
  as `wakeBudget` (issue #259).
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

- Control Plane: Claude delivery progress builds the task request index once
  per observation instead of once per session; behaviour is unchanged
  (issue #266).
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
- Atlassian brokers: all four brokers parse arguments strictly from a per-verb
  flag table in the new shared module `atlassian-cli-args.mts`, which installs
  with the default Confluence set. A positional argument, an unknown flag, a
  flag without a value, a repeated flag or a missing required flag is refused
  before any configuration, credential or network access, and the message
  names the verb's full syntax and, for a positional, the call it probably
  meant (`Did you mean: get --id 275907063`). Before, the Claude Jira and both
  Confluence brokers skipped positionals and unknown flags silently and kept
  the last of a repeated flag. `help`, `--help` and `-h` list every verb with
  its flags and exit 0; the Codex Jira broker returns the list as JSON.
  `selftest` with arguments is now an error, a caller-supplied `--version` on
  Confluence `update` is refused instead of ignored, and a refused `search`
  call stays `status: unavailable` with exit 2. `stitch --dry-run --id <id>`
  keeps the id instead of reading `--id` as the value of `--dry-run`, and the
  routing documents name `stitch --space <key> --id <id>` (issue #299).

### Removed

- The MPAC tools (`modules/mpac-tools/`, Atlassian Marketplace vendor
  reporting). They are not part of Kherep's purpose. The installer no longer
  places `<workspace>/tools/mpac/` and drift-check no longer compares it;
  `KHEREP_INSTALL_ATLASSIAN_TOOLS` now gates only the Jira helpers. On hosts
  that installed them earlier, an upgrade parks `<workspace>/tools/mpac/mpac.ps1`
  and `README.md` in `<workspace>/tools/mpac/_deprecated/` through the
  retirement manifest.

### Fixed

- Claude hooks: `live-hook-integrity` and
  `bootstrap/wired-blocking-guards.test.mts` no longer use `node --check` for
  `.mts` files. `node --check` never type-strips a `.mts`: it compiles the raw
  source as CommonJS with module detection, exits 0 for any file that contains
  `import` or `export`, so `export const x = ;` passed as healthy, and rejects
  valid type annotations in a file without them, so a healthy hook such as
  `const x: number = 1;` was reported as broken and overwritten (measured on
  Node 26.10.0; the same code is in 22.18.0 and 24.1.0 by source). The new
  `hooks/lib/hook-syntax.mts` runs the two parsers Node runs at load time,
  in-process and without executing the hook: `module.stripTypeScriptTypes`,
  then a V8 module parse of the stripped source through a `data:` import whose
  link is made to fail, so top-level code never runs; about 1 ms per file
  instead of a child process. A report line for such a file reads "rejected by
  Node's parser". The `.js` path (`vm.Script`, confirmed by `node --check`) is
  unchanged. Only the stripper's own ExperimentalWarning is filtered in the
  hook's process; every other warning, Node's type-stripping warning included,
  still prints. Known limits: link-time SyntaxErrors such as
  `import { nope } from "node:fs"` are not detected, as `node --check` never
  detected them; a Node build without `module.stripTypeScriptTypes` gives
  UNGEPRUEFT, never OK; and the new library joins the integrity hook's own
  imports, which it cannot heal for itself (issue #279). Tests cover the ESM
  error shapes, TypeScript-only and V8-only errors, valid typed code without
  imports, non-execution, BOM and CRLF, the warning filter and the
  command-line entry `node hooks/lib/hook-syntax.mts <file>`.
  `bootstrap/smoke-test.sh` follows separately (issue #278).
- Claude hooks: `live-hook-integrity` now also measures the files a wired hook
  imports, the transitive closure of its relative static imports under
  `hooks/` (including `hooks/lib`), classifies each as missing, 0 bytes or
  rejected by `node --check`, and restores it from the checkout with the same
  SHA-256 proof as a wired file. `node --check` does not resolve imports, so a
  hook whose library was missing or empty passed it and then failed at import
  with exit 1, which Claude Code treats as non-blocking: a blocking guard
  failed open without notice. A report line names the importing hooks, and the
  journal entry records `kind` and `importedBy`. A restore now refuses to write
  through a symbolic link or into a directory that resolves outside the hooks
  directory. The inventory lives in the new `hooks/lib/hook-inventory.mts`,
  which the installer manifest lists, and
  `bootstrap/hook-require-resolution.test.mts` now fails when a file of that
  closure is missing from the manifest. New tests cover a missing, empty and
  syntax-broken library, a transitive and a sibling import, type-only imports,
  comments, imports outside `hooks/`, symlinks and the report-only case
  without a checkout. Known limits: an ESM-shaped syntax error in a `.mts`
  file, such as `export const x = ;`, is not detected, because `node --check`
  exits 0 for it on Node 26.10 (follow-up issue #278); the syntax-broken test
  uses a shape that `node --check` rejects. The integrity hook cannot heal its
  own three library imports (`lib/workspace-scope.mts`,
  `lib/orchestra-checkout.mts`, `lib/hook-inventory.mts`): if one of them is
  broken the hook itself fails at import, and only `drift-check` and the smoke
  test cover them (issue #273).
- `commit-guard.mts` no longer backtracks exponentially while it looks for
  `git ... commit` (issue #271, CodeQL `js/redos` alerts #16 and #17). Its
  regex read `-C` both as a flag and as a flag with a value, and `--long` both
  as `--` + `long` and `-` + `-long`; `git ` followed by 26 `-C -- ` pairs took
  2.3 s, and the time about doubled with each further pair, so a hook timeout let the call
  through. The new `hooks/lib/git-commit-match.mts` splits the command into
  tokens once and tracks the reachable tokens in one linear pass. It accepts
  exactly the strings the regex accepted: a seeded differential test of
  20,000 short token sequences finds no difference, and the guard's other
  checks are unchanged. The installer manifest lists the new module.
- Control Plane: on Windows the wake hook's kept run mode now hits (issue
  #248). Claude Code starts each hook through Git Bash, so the key
  `run-modes/<session_id>.<parent pid>.json` was new for every hook: each
  hook paid the full process listing (348 to 362 ms, measured 2026-10-06) and
  wrote an entry nobody read. A `claude -p` took a median of 8.1 s with the
  hooks against 5.6 s without them; this removes the listing from that
  difference after the first hook. The entry is now keyed on `CLAUDE_PID`,
  Claude Code's own pid, which survives the shell and which a nested
  `claude -p` sets anew, when it is a plain pid above 1; otherwise the parent
  pid stays the key, and when that parent is a shell nothing is written or
  pruned. Only a positive signal is headless, and an entry still answers only
  for what a full check of the same Claude Code process found, with the same
  entrypoint and within one hour.
- Control Plane: an interactive Codex TUI whose rollout starts like a Desktop
  chat (Codex 0.160) is woken with `codex queue` again instead of waiting with
  `awaiting-user-turn` (issue #268). New `codex-daemon.mts` asks the shared
  app-server daemon for `thread/loaded/list` over its control socket, a
  WebSocket over a unix socket, with a 2 s timeout and a 10 s cache. Only a
  thread the daemon lists that also has the marker
  `<codex home>/tui-thread-reference-capabilities/<id>` takes the TUI queue
  path, audited as `tui-reachable`; any probe failure, a missing marker, a
  thread missing from the list, and Windows, where the probe does not
  connect, keep the Desktop behaviour. `wake.codexApp` skips a reachable TUI,
  which needs its full id in `wake.sessions`.
- Codex hooks: `commit-guard` and `deploy-guard` now block under Codex on
  Windows (issue #258). Codex runs the Windows hook form under pwsh, which
  reports the guard's exit 2 as 1, and Codex treats that as a failed,
  non-blocking hook, so the tool call went ahead. `codex-hook-adapter.mts` now
  answers a guard's exit 2 in the PreToolUse phases with the documented JSON
  deny on stdout (`hookSpecificOutput.permissionDecision: "deny"`, the guard's
  stderr as `permissionDecisionReason`, or a fixed reason naming the guard when
  stderr is empty) and exits 0, on every platform. In a multi-command payload
  the first block answers alone and nothing after it runs. A guard's own JSON
  decision, a silent exit 0, any other exit code and the PostToolUse phase
  behave as before. The Claude Code wiring, which runs the guards directly, is
  unchanged.
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
- Codex installer: a managed block that the Codex app split while storing hook
  trust is installed again instead of refused (issue #274). On a Windows host
  the app had written its `[hooks.state]` trust tables inside the block, moved
  the managed tail (the Control Plane deliver hooks and
  `[mcp_servers.kherep_messaging]`) verbatim behind the end marker, and left
  one trust table's `enabled = false` after the marker. The TOML was unchanged,
  but no known fragment matched, so the installer refused and a shared-guard
  fix could not reach Codex. The installer now puts the tail back into the
  block and the trust tables, with their keys, behind the end marker, then runs
  the unchanged exact match. It does so only when the block without its trust
  tables is the exact start of a known fragment and the exact rest follows the
  marker with nothing but trust tables in between, and moves a key after the
  marker only together with a trust table that ends the block. Anything else,
  such as a changed managed line, an unknown table, unknown content in the
  block or CRLF line endings, is still refused. The hooks arrays and the trust
  state are kept, so no hook needs to be trusted again.
- Bootstrap: on Windows `smoke-test.sh` looked hung in
  `install-transaction.test.sh` and was killed after six minutes, which also
  withheld every result it had buffered (issue #276). The sub-test was not
  hung: under Git Bash it takes about 12 minutes and printed nothing after
  `test_lock`, and the Windows process list showed its bash idle without
  children because MSYS fork and exec do not keep Windows parent links. The
  transaction test now names each test on stderr as it starts, and
  `smoke-test.sh` runs it under `timeout` with a 30-minute bound, set with
  `SMOKE_SUBTEST_TIMEOUT`, so a real hang becomes a finding and the report is
  still printed. Without GNU `timeout` or `gtimeout`, as on a stock Mac, it
  runs unbounded as before.
- Observation agent: on Windows `claude-obs` left its page bodies in the
  calling session's working directory as untracked files named like
  `C<U+F03A>Users...finding1_body.txt` (issue #280). The agent had no rule for
  creating its `--body-file` and wrote to the backslash scratchpad path from
  Bash, where the backslashes vanished and MSYS mapped the drive colon to
  U+F03A, so the path became a relative file name. The agent now creates the
  file with `f="$(mktemp)"`, passes `--body-file "$f"`, removes it after the
  broker call and never uses a Windows backslash path in Bash; the contract
  test pins that. `codex-obs` writes no files and is unchanged. The
  observation Stop hook also reads the top level of the working directory and
  its git root and, when names starting with `C` and U+F03A are there, shows
  their count and one shortened example as a warning. It never moves or
  deletes them.
- Bootstrap: `smoke-test.sh` no longer uses `node --check` for the wired
  hooks' `HOOK SYNTAX` and `LIVE HOOK SYNTAX` checks, so a `.mts` hook with an
  ESM syntax error such as `export const x = ;` is a finding instead of a pass
  (issue #278). A `hook_syntax()` helper calls `hooks/lib/hook-syntax.mts`: the
  repo copy for the repo source, and for the live hook the copy installed next
  to it, without falling back to the repo copy, so a missing installed library
  is a finding too. Only a proven OK passes. UNGEPRUEFT, a missing checker and
  any other exit are findings marked `UNCHECKED`, never a silent pass; such a
  finding names the first `Error` line of a failing checker, and a trailing CR
  on the checker's output is ignored. `.js`
  hooks keep their check through the library's dispatch.
  `hooks/lib/hook-syntax.mts` is now in the smoke test's list of installed
  files. The comments in `commit-guard`, `playwright-file-guard` and
  `secret-output-guard` no longer claim that their `node:process` import marks
  the file as ESM for `node --check`; nothing needs that import any more.
- Claude hooks: the observation Stop hook's stray-file warning now matches any
  drive letter followed by U+F03A, not only `C`. A body written from Bash to a
  `D:\...` path, where a workspace can sit, became a `D`+U+F03A file in the
  working directory and was not reported. A name that only contains U+F03A
  further in is still ignored.
- Claude hooks: `live-hook-integrity` no longer writes a restore through a link
  planted after its check (issue #279). The restore checked the target with
  `lstat` and then wrote with `copyFileSync`, which follows a link at the
  destination on every platform. The new `hooks/lib/restore-write.mts` opens
  the file without `O_TRUNC`, with `O_NOFOLLOW` where the platform has it, and
  writes only when the opened file has the `(dev, ino)` the path had; on Windows
  a volume without file ids is refused. A swapped-in file is left
  byte-identical. A linked `<CLAUDE_HOME>/hooks` is still restored at its
  target on purpose, and a test pins that; a link at the file or at a
  subdirectory that leads elsewhere is still refused. The hook now loads its
  own libs with dynamic `import()` and checks the functions it uses, so a
  missing, 0-byte or broken lib no longer makes it exit 1 unreported: it
  reports one line, journals it as kind `self`, exits 0 and restores the lib
  when `workspace-scope`, `orchestra-checkout` and `restore-write` loaded.
  `hooks/lib/hook-inventory.mts` and the install manifest test also follow a
  string-literal `import("./x.mts")`, not `typeof import()`, and the inventory
  scan ignores a leading byte order mark. `hooks/lib/restore-write.mts` is in
  the install manifest, the required hooks and the smoke test's list of
  installed files.
- Claude hooks: `hooks/lib/hook-syntax.mts` follow-ups from the review of PR
  #283. The stripper's ExperimentalWarning is now dropped by swapping
  `process.emitWarning` only for the duration of the
  `module.stripTypeScriptTypes` call instead of re-registering the process's
  warning listeners, which had made a `once` listener fire more than once and
  still delivered the warning to listeners attached later; every other
  warning, Node's own type-stripping warning included, still prints, and
  `quietStripWarning()` stays exported as a no-op for its callers. For `.js`
  and `.cjs`, a `node --check` child that did not run or did not finish
  (ENOENT, ETIMEDOUT after 15 s, a signal, exit 9 for a bad `NODE_OPTIONS`, a
  `SyntaxError` from a preload rather than the checked file) is UNGEPRUEFT
  "vm.Script rejected it and node --check could not confirm (...)" instead of
  DEFEKT; only a child that exited non-zero on its own and printed a
  `SyntaxError` for the checked file is a rejection. The probe import that
  keeps a checked module from linking now carries an import attribute that
  Node's load step rejects, so a `--import`/`--require` customization hook that
  resolves the probe specifier is stopped by Node's load step before anything
  is instantiated (UNGEPRUEFT, never OK); before, the checked file's top-level
  code ran first. Residual risk: a hook that also overrides the import
  attributes, short-circuits `load`, or returns a format whose attributes Node
  does not validate (`module-typescript`, `commonjs-typescript`) can still
  bypass the probe and run the checked file; the verdict then stays
  UNGEPRUEFT, never OK. Such a hook owns the process and is outside this check.
  Measured on Node 26.10.0; same source paths in 22.18.0 and 24.1.0.
- Research Stop hooks: Claude and Codex now recognise the same opt-out marker.
  Codex accepted only an ASCII hyphen after `none` and rejected the marker
  with an en dash (U+2013) or em dash (U+2014), which models write in
  practice, so such a turn was sent back once for research it had declared
  irrelevant; Claude accepted anything after `none`, including
  `[research: none]` without a reason, although ROUTING.md and both hook texts
  require one. Both runtimes now use one pattern: a hyphen, en dash or em dash
  followed by a nonempty one-line reason without `[` inside the brackets,
  matched anywhere in the final assistant text of the ending turn. Excluding
  `[` keeps a line of unterminated markers linear: 8000 of them took 1.8 s
  with a reason that could span them and under a millisecond now. A bare `[research: none]` in
  Claude now gets one continuation instead of opting out. The documented form
  stays `[research: none - <reason>]`. A shared contract test runs the same
  cases against both patterns and fails when they drift (issue #293).
- Codex hooks: a hook-integrity check now runs in every Codex session
  (#275). Before, only the Claude `live-hook-integrity` hook checked hook
  files, and only when a Claude session started, so a missing or 0-byte shared
  guard under `<CODEX_HOME>/hooks` failed open on a day with only Codex
  sessions. `codex/hooks/hook-integrity.mts` is installed as
  `hooks/kherep-maestro/codex-hook-integrity.mts` and appended as the last
  entry of the Maestro `SessionStart` group (`timeout = 30`), after the
  optional native hook, so every existing entry keeps its positional trust
  key. It checks every `.mts`/`.js` hook file that `config.toml` wires under
  `<CODEX_HOME>/hooks`, their import closure and the libs the privacy guard
  loads through a computed `require`. A broken file is restored from the
  checkout named by the deliver-hook command, else from the Claude-side
  checkout chain, and counts as restored only when a re-read matches the
  checkout's SHA-256. The two installer-rendered observation hooks are
  reported only, and without a checkout nothing is written. Findings go to
  `<CODEX_HOME>/.cache/hook-integrity/incidents.jsonl`; the hook is silent
  when everything is OK and always exits 0. A failing own lib is reported as
  kind `self`. The installer recognizes the previous managed block and
  upgrades it; Codex then asks to review exactly the one new hook.
- Claude hooks: `hooks/lib/hook-syntax.mts` no longer lets a `NODE_OPTIONS`
  preload decide the `node --check` confirmation of a `.js` or `.cjs` file
  (issue #292). A preload that printed one stderr line turned a real
  rejection into UNGEPRUEFT, and a preload calling `process.exit(0)` made a
  broken file OK, a false OK. The check child now runs without
  `NODE_OPTIONS` (matched case-insensitively on Windows), so no preload can
  print, exit early or forge a rejection; this is the policy the `.mts` path
  has had since #284, only Node's default loader is trusted. An operator's
  `--no-experimental-detect-module` is therefore not applied either. The
  rejection is read from the block Node prints (`<path>:<line>`, source line,
  caret, blank line, `SyntaxError: ...`): a `SyntaxError` line counts only
  when a line within the four above it names the checked file, wherever the
  block sits in stderr, so lines printed before it (`NODE_DEBUG`, a loader
  warning) no longer hide a rejection. The `node --check` tests move to
  `hooks/lib/hook-syntax-check.test.mts`. The ExperimentalWarning control in
  `hook-syntax.test.mts` records whether this Node still warns for
  `module.stripTypeScriptTypes` (`MEASURED |`) and asserts the filter only
  while it does. Measured on Node 26.10.0; Node 22.18.0, 24.1.0 and the
  Windows path format are read from Node's source.
- Claude hooks: `hooks/lib/hook-syntax.mts` now reports a `.js` or `.cjs` file
  DEFEKT when `node --check` rejected it under another name (issue #298).
  Node prints the realpath of a file or directory symbolic link and honours a
  `//# sourceURL=` comment, so a broken hook reached through a renamed link,
  or one carrying such a comment, was UNGEPRUEFT instead of DEFEKT (never OK).
  Since #292 the check child runs without `NODE_OPTIONS` and parses only the
  checked file, so the rejection block (`<location>:<line>`, source line,
  caret, blank line, `SyntaxError: ...`) now counts whatever its location
  names, as long as it is not a `node:` internal frame and the child exited
  non-zero on its own; Node's own failures (a missing file, an invalid
  `package.json`) stay UNGEPRUEFT. When the name differs from the file's, the
  reason says so. Measured on Node 26.10.0 on macOS and, for a directory
  junction, on Windows 11; Windows file links are read from Node's source.

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

[Unreleased]: https://github.com/cfaysal/kherep/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cfaysal/kherep/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/cfaysal/kherep/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/cfaysal/kherep/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cfaysal/kherep/releases/tag/v0.1.0
