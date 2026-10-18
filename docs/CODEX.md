# Codex integration

Kherep projects shared rules, skills and agents into Codex through a separate adapter. Claude and Codex keep their own configuration and account bindings.

## Install

Use Node.js 24 and the shared dependencies described in [Installation](INSTALLATION.md). From the checkout:

```sh
node codex/install.mts --workspace "$HOME/projects"
```

Replace the workspace with your chosen absolute path. The installer uses your Codex configuration home and existing MCP source registry. Shared knowledge lives in the Central Brain, the Confluence space this installer resolves for the host; see [turn-completion observations](#turn-completion-observations).

On Windows, the PowerShell entry point accepts the same workspace:

```powershell
./codex/install.ps1 -Workspace C:/Projects
```

To record standing authority for Codex observation publication, add the explicit
`-AuthorizeObservationPublishing` switch. The switch is intentionally separate from target
configuration: a configured space alone never grants publication authority.

Review a disposable candidate before replacing an existing setup. The CLI supports these options:

| Option | Purpose |
| --- | --- |
| `--workspace` | Workspace in which Kherep applies |
| `--codex-home` | Destination Codex configuration home |
| `--claude-config-dir` | Shared Claude dependency/configuration home |
| `--mcp-registry` | Absolute path to your source MCP registry |
| `--memory-provider-config` | Absolute path to explicit memory-backend selection JSON; only `{ "provider": "unconfigured" }` is accepted |
| `--enable-messaging-client` | Install the disabled-by-default local Control Plane messaging MCP client and exact intent hook |

Both entry points run `codex/install.mts`, so the two host-owned values it needs are resolved by the same run whichever one you use: the Confluence knowledge space for this host, written to `kherep/confluence.json` in the resolved Codex home, and the Atlassian service-account credential. Each prompts only when a terminal is attached and otherwise fails with the variable named, so a scripted install does not block on stdin. If either is missing the parity installation above it still stands, and the observation agent writes nothing until the space file exists.

Keep private registry configuration outside the checkout. Read [adapter architecture](../codex/ARCHITECTURE.md) for supported transport, authentication and backend-selection formats.

### Remote messaging client opt-in

`--enable-messaging-client`, or `-EnableMessagingClient` through `install.ps1`, adds the
`kherep_messaging` stdio MCP table and the exact five-tool PreToolUse intent hook. API callers use
`install({ messagingClient: true })`. The table contains only the Node executable, installed bridge
path and non-secret Kherep config-root path. It contains no bearer, endpoint, native identity or
approval override. A normal install without this option projects neither the table nor the hook.

The local bridge reloads node configuration, effective policy and the private rotating credential
for every HTTP request. It derives `/mcp` from the enrolled node's control URL, sends the bearer only
in the HTTP Authorization header, rejects redirects, and forwards native JSON-RPC and `_meta`
without adding caller, thread or session identities. Callers omit the hook-owned `requestId`. After
a durable intent receipt, the hook returns `permissionDecision: "allow"` together with `updatedInput`
to apply the [native PreToolUse argument rewrite](https://learn.chatgpt.com/docs/hooks#pretooluse).
Normal Codex MCP approval remains in force.

This client option does not enable the Worker's committed remote MCP flag or the node's
`remoteMcp.enabled` policy. Both remain separate explicit activation gates. Validate installed source
and config at the target, then run direct and two-distinct-chat production canaries before treating
the client as supported. The binding probe's Code Mode result is separate probe evidence.

## Turn-completion observations

On both hosts, the managed `Stop` group retains the acceptance gate and adds the once-only research gate, but it no longer requests an observation continuation. The `UserPromptSubmit` context hook gives the Maestro a short, quiet turn reminder to dispatch `codex-obs` before its final response, while the separate research prompt hook supplies the evidence-first instruction. Missing required research can therefore produce one visible continuation prompt. Observation dispatch stays quiet. A reinstall replaces the exact old macOS and Windows managed Stop projections; their old script files may remain in the installation but are not configured as hooks.

The normal Codex projection installs `codex-obs`, rendered from the Codex-only worker definition `codex/agents/codex-obs.md`, and the minimal twelve-file service-account Confluence graph in `<workspace>/tools`. The graph contains the Codex `atl-confluence.mts` broker, the shared `atlassian-credentials.mts` parser, the shared `atlassian-cli-args.mts` argument parser and the nine `confluence-*` modules for contract, content, session, related-page search, semantics, neighbours, neighbour CLI, runtime labels and the label CLI.

The Maestro dispatches `codex-obs` once with `fork_turns: "none"` and a bounded nonprivate turn summary. The worker performs no configuration or broker I/O and returns one strict JSON candidate envelope. Its projected role uses `sandbox_mode = "read-only"`; restricted subagent execution also does not grant it the Maestro's escalated network authority. Each candidate contains exactly `title`, `bodyStorage`, `evidence`, `labels` and `placement`; placement contains only `project` and `app`, while labels contain only `type-observation`, `evidence-<value>` and `status-author-model`. The trusted Maestro validates the result and adds session or runtime details during publication. An empty `observations` array performs zero writes. For nonempty candidates, the Maestro checks canonical publication authority and runs related-page search, create/readback and stitch through the Codex broker. The context hook forwards no prompt or transcript content. Hook configuration and tests establish the projected flow; verify actual dispatch and delivery on each Desktop host separately.

A `SubagentStop` hook with matcher `codex-obs`, `hooks/kherep-maestro/codex-obs-result-check.mts`, checks that candidate before the result reaches the Maestro. A malformed candidate, a Markdown-fenced one included, is sent back to the worker once with a fixed instruction; a second malformed result only shows the operator a warning, and the Maestro publishes nothing. When neither `last_assistant_message` nor the subagent rollout is visible to the hook, it says so, and the Maestro's own validation remains the check. The group is the last hook group of the managed block, so an upgrade adds one group and Codex marks exactly this new hook for review; trust it with `/hooks`. Whether Codex reports `agent_type` as `codex-obs` for a `spawn_agent` worker, and whether the block continues the worker before `wait_agent` returns, is UNKNOWN until measured on a Desktop host.

### Evidence-first research hook

For headless broker research, opt into approval review for that invocation:

```sh
codex exec --approve-for-me "Research the configured knowledge space before answering; request command-scoped approval if sandbox networking blocks the read-only broker search."
```

Use `--skip-git-repo-check` as well when the working directory is not a Git repository. `--approve-for-me` selects the workspace-write sandbox and routes eligible approval requests through automatic review; do not combine it with `--sandbox`, which the CLI rejects. If the read-only broker search is blocked by sandbox networking, the agent requests `sandbox_permissions="require_escalated"` for that command; the reviewer can allow or deny it. This does not grant approval for other broker verbs, remove privacy guards, or enable global networking. A run with `approval_policy="never"` has no path to request that escalation. Follow managed approval requirements; a denied request stays denied.

A broker `status: unavailable` means the lookup could not run and the result is UNKNOWN. It does not prove that Confluence is down or that no page matches. Compare the failing boundary with an authorized read before reporting an outage. Search exit 0 means hits, exit 1 means the search ran without matches, and exit 2 means unavailable. A shell wrapper may report a different process exit code, so inspect the broker status as well. See the [official sandbox and approval documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

The native `research-first` prompt hook emits a fixed local instruction and no prompt text. The `research-stop` hook reads only the absolute local Codex rollout path in the Stop payload, rejects Claude-private paths, and examines the latest matching `task_started` turn. It accepts direct `function_call` and `custom_tool_call` records, including the hyphenated and underscored codebase-memory server names. A local lexer also recognizes actual `tools.*(...)` call syntax inside `functions.exec`, including records with separate `name: "exec"` and `namespace: "functions"` fields and the `custom_tool_call` named `exec` without a namespace field that Codex Desktop records. A bare `exec` `function_call` and other namespaces do not count as this wrapper. A nested `exec_command` counts when its command is the broker search; a later `write_stdin` that collects the process output is neither required nor evidence. Quoted examples, comments, template literals and regular-expression literals in the supported JavaScript contexts do not count. User messages and tool output never count. Dynamically constructed JavaScript remains outside this classifier. This lexical evidence records an attempted call only. It does not prove that a conditional branch ran, that a lookup succeeded, or that the result supports the answer.

A substantial turn must show a Central Brain lookup attempt. A detected repository change through `apply_patch`, an explicit file-write tool or a common shell mutation command also requires a codebase-memory call. Feedback names only the missing Brain attempt, graph attempt or both, with the existing privacy and opt-out instructions. Missing evidence is not reported as a service outage. The existing 400-character and three-read-only-call thresholds and observation-call classification stay unchanged. Arbitrary shell programs can hide file mutations from this classifier. A final `[research: none - <reason>]` with a nonempty reason opts out. The Stop hook blocks only when `stop_hook_active` is exactly false, so its continuation cannot loop. It emits fixed text and never emits transcript content or performs network I/O.

A wholly malformed, unreadable, relative, Claude-private or unrecognized transcript is undecidable and fails open. A malformed trailing line is ignored when earlier records still identify and describe the requested current turn. Codex's rollout format is unstable, so an undecidable read is documented rather than treated as evidence that research was absent. Under the [official Codex Stop hook contract](https://learn.chatgpt.com/docs/hooks?translationFallback=de-DE), a matching `continue: false` result takes precedence over continuation decisions. If the acceptance gate rejects the same stop, Codex stops on that result and does not surface the research continuation. The research gate therefore enforces the once-only continuation when acceptance allows stopping.

The source check named research parity covers only `research-first.mts` and `research-stop.mts` in the Claude and Codex adapters. It fails if one of those four source files is missing. It does not establish general Claude/Codex parity. Repository tests establish source behavior and projected configuration. Whether a particular Desktop host trusts and executes both hooks remains UNKNOWN until the installed target is inspected and a missing-research turn is observed there.

### Post-edit checks

Codex config projects one `PostToolUse` command for edits and `functions.exec`: `hooks/kherep-maestro/codex-post-edit-checks.mts`. It normalizes the payload with the existing post adapter and runs the four shared manifest, line-count, Umlaut transliteration and simplifier watchers as sibling Node processes. Their plain findings and valid JSON findings are combined into one `PostToolUse` JSON response. An all-green run is silent. Child errors and nonzero exits are forwarded.

The existing literal classifier skips the dispatcher body when the entire `functions.exec` source is a sequence of direct calls to explicitly listed Codebase Memory read-only tools with literal arguments. Dynamic or unknown wrappers still use conservative normalization, preserving every recognized patch target. If normalization yields `Bash`, no watcher children start, because all four shared watchers reject that tool before examining input. This also removes four empty children for ordinary shell/status wrappers. Edit and patch targets retain all four checks.

A reinstall replaces the exact prior four-command group with the one dispatcher command. Existing custom hook groups and positional hook state entries remain in place, and the installer does not create a trusted hash for the dispatcher. Any unknown drift in the predecessor is refused. Installation and source tests establish only the configured projection. Desktop execution and latency are UNKNOWN until the installed hook is separately activated and measured.

### Shell checks and hook starts

The shell `PreToolUse` group uses one `codex-shell-checks.mts` command instead of three adapter commands and a separate attribution command. All three guards still execute with their original normalization; privacy remains independent. Guard execution failures return a native JSON deny. After the guards, pre-tool attribution resolves the attribution hook through the stable entry point described below and calls it in-process with the original owner payload; a missing or invalid source record skips attribution with one stderr line and never skips a guard or changes a deny; post-tool attribution and the independent Intercom return-point consumer remain configured.

Reinstall recognizes the exact prior shell group, preserves custom groups and existing state bytes, and refuses unknown drift. Group positions remain stable, but the consolidated command changes its definition and requires review in `/hooks`; the installer supplies no trusted hash. Inspect the isolated candidate before an authorized host update, review the definition and restart the affected native session. Source tests establish the projection and functional behavior. Native Desktop execution and Hook-Runs accounting require the bounded [host acceptance procedure](CODEX-HOOK-RUNS.md#host-acceptance).

The per-turn Maestro reminder is shorter but retains its evidence, privacy, delegation, acceptance and observation rules. It remains present on every prompt. Research and the session-bound receive recipe are not cached away, so compacted or restarted sessions still get the current instructions.

This minimal graph does not enable the broader Atlassian surfaces. `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is the explicit opt-in for the Codex Jira graph, the Claude Jira and Confluence broker copies, and the managed v2 Atlassian remote MCP server `atlassian` (`https://mcp.atlassian.com/v2/mcp`). Codex reaches that server as the Codex service account: the managed table runs `orchestra/supergateway-secret-wrapper.mts` with the API key file `KHEREP_ATL_MCP_TOKEN_FILE_CODEX` (default `<CODEX_HOME>/kherep/atl-mcp-credential-codex.txt`) and sets `approval_mode = "prompt"` for `executeDestructive`. Without a usable key file, or with a file that belongs to the Claude service account or a broker credential, no table is written, the installer warns and exits 1, and the receipt's `atlassianMcp.status` says why. A block with the earlier native OAuth table is replaced. An upgrade keeps the tool set when the installed managed block carries an `atlassian` table: without `KHEREP_INSTALL_ATLASSIAN_TOOLS` it is installed again, and the key file the installed service-account table names is reused ahead of the default (receipt `tokenSource` `installed`); `KHEREP_ATL_MCP_TOKEN_FILE_CODEX` still wins. If that table's key file is not usable, the installer stops before writing anything and names the file and the variable. `KHEREP_INSTALL_ATLASSIAN_TOOLS` set to any value other than `1` opts out, removes the managed table and records `atlassianMcp.status` `removed`. See [Atlassian MCP server](INSTALLATION.md#atlassian-mcp-server). An operator's own `atlassian` table outside the managed block is preserved. The v1 `rovo` table is retired, and the installer no longer registers the legacy `atlassian-rovo@openai-curated` plugin; a registration from an earlier install stays until the operator removes it. The Claude bootstrap installer places both Confluence brokers by default, because it installs `claude-obs`. Codex and Claude brokers continue to use separate service-account credential bindings.

### Windows target setup and migration

`codex/install.ps1` forwards the publication switch to the shared Node installer. The Node installer resolves the Codex credential first and then runs the space setup once. That setup also resolves placement nodes through the Codex service account and persists them beside the space identity.

The shared Node installer resolves the observation target and writes `<CODEX_HOME>/kherep/confluence.json`. It selects a space key in this order: `KHEREP_CONFLUENCE_SPACE_KEY`, an existing canonical file, the legacy `<CODEX_HOME>/orchestra/confluence.json`, then an interactive prompt. Only `spaceKey` is read from a legacy file.

The helper does not copy legacy bytes. It reads the selected space through the Codex `atl-confluence.mts` service-account broker and writes the canonical `spaceKey`, `spaceId` and `spaceName` only after that read succeeds. With `-AuthorizeObservationPublishing`, it also writes the literal `observationPublishingAuthorized: true`. A later run without the switch preserves an existing canonical literal `true` only when the prior canonical `spaceId` equals the newly resolved `spaceId`; a fresh run or a changed space identity omits the property, and authority is never imported from the legacy file. The helper never writes a false value. It retains the legacy file. If target setup fails, the parity installation remains installed but the warning means the Confluence destination is not established and observation delivery is UNKNOWN.

Before any Codex observation write, the trusted Maestro main thread reads the canonical file and
requires `observationPublishingAuthorized` to be literal `true`. That value is durable standing authority
only for non-secret observation pages in the configured space through the Codex service account.
It does not authorize another space, another content type, secrets, permission changes or another
identity. If the property is absent or has any other value, the agent writes nothing and reports
`publication not authorized`. The candidate worker never reads this file or calls the broker.
Claude's direct broker authorization and publication path is unchanged.

## Messages for the current Codex app session

A Codex desktop app restart starts a new session with a new id, so a `wake.sessions` list of full ids stops matching the session the operator works in. The optional node policy field `wake.codexApp` (boolean, `false` when a written `wake` section omits it) adds one grant for it. A policy file without a `wake` section gets the built-in default `{ "enabled": true, "sessions": ["*"], "codexApp": true, "replies": true }`, so waking, this grant included, is on by default; `"wake": { "enabled": false }` turns it off (issue #390):

```json
"wake": { "enabled": true, "sessions": [], "codexApp": true }
```

With `codexApp: true` the list may be empty or absent. Any non-boolean value turns waking off, as a malformed list does. The grant selects exactly one Codex session that the list does not name: the most recently seen session recorded by the delivery hook whose rollout, `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, begins with a `session_meta` line for that id with `originator` `"Codex Desktop"` and `source` `"vscode"`, and no parent thread. The node reads that line itself. It searches the newest 62 date directories, reads at most 256 KiB, follows no links and refuses a missing, unreadable or garbled file or any other value. Exec runs, Codex tasks and app subagent threads are never granted. If two app sessions share the latest time, neither is granted. A TUI reachable on the shared app-server daemon (below) is never granted and is skipped when the newest app session is chosen.

An eligible Desktop or Terminal session receives a CP hint admission. The node
publishes metadata directly after the existing authorization guards. When
`wake.nativeQueue` is `true`, a separate guarded producer submits a fixed native
Queue pointer to that exact owner, retaining peer text in the persistent CP Inbox.
Native arbitration waits while active and can start the same idle loaded owner.
No thread is resumed or replaced. Legacy queue bindings remain untouched.
The producer is off by default (issue #429): a `wake` section without
`nativeQueue`, the built-in default included, submits no native Queue card, and the
owner still gets the CP hint. `nativeQueue` grants nothing by itself; the owner
still needs full-id authorization or the `codexApp` grant. Any non-boolean value
turns waking off, as for `codexApp`:

```json
"wake": { "enabled": true, "sessions": ["<full thread id>"], "nativeQueue": true }
```

The Composer's Queue or Steer default is an independent user preference and does
not control this route. Kherep does not change that setting.

Each synchronous Codex admission round reads, parses and indexes the Inbox once
after finding eligible non-task owners. Decisions reread only indexed records for
that owner's full id and unique aliases. Records already consumed, removed or
readdressed are excluded; arrivals after the snapshot wait for the next round.
The index is discarded at the end of the round. Publication rechecks required
policy, enrollment, kill switch, permissions, task exclusion and the admitted
references. It does not add newly arriving records.

A ticket carries at most eight admitted ID/address pairs, its exact owner, an
immutable generation, TTL and policy fingerprint. The trusted synchronous native
PostToolUse hook validates original-owner identity from the native session and
transcript basename without opening the transcript. It checks current policy and
permissions and reads only those bounded references. A durable claim produces
one fixed additionalContext hint in the same running turn at the next supported
tool boundary. The hint contains no peer bodies, IDs, paths or receive command.
This does not interrupt sampling or send a literal `turn/steer` RPC. Without a
tool boundary, an opted-in native pointer remains available for the next
eligible turn.
The existing Stop continuation remains available for accepted messages
under its existing budget and permissions.

Idle evidence (issue #408): the node's record of each Codex session keeps the
last hook event that reached it and when, plus the time of the last `Stop`.
The original owner's `PostToolUse` refreshes the event of an existing record
only; a subagent's call writes nothing. A session counts as idle only when its
last event is a `Stop` that ended its turn at least 90 seconds ago and it was
seen within 12 hours.
This is evidence, not proof. Only the opt-in Codex fork reply below acts on it;
`msg sessions` shows the last event of this node's Codex sessions and
`kherep-node doctor` counts them per event. A turn ended by native
`turn/interrupt` fires no `Stop` (measured on Codex 0.162.0-alpha.17.2 and
0.163.0), so an interrupted turn leaves the session not idle until a later
turn completes. CLI Escape fires no `Stop` either (measured on macOS with a
positive `Stop` control); the Desktop stop button is not
measured.
Whether an approval wait can be told apart is UNKNOWN. A `Stop` counts as ending its
turn only once the hook marks it with `lastStopEnded`, after recording it, on
every exit that returns no blocking continuation; every hook event clears the
mark. A `Stop` that blocked, or whose mark could not be written, does not count
as idle.

Codex fork reply (issue #408, in progress). Nothing changes while
`wake.codexFork` is absent, except that relays made while it was present are
still withdrawn when the owner reads and cleaned up after 24 hours; nothing is
sent, forked or audited. With it present only `darwin` is accepted, and the
answer is relayed to the peer as one labelled proxy answer while the owner stays
idle (below). Upgrade the Worker before the nodes. The section names the Codex chats whose
history an ephemeral read-only fork may use to answer an idle owner's peer
message:

```json
"wake": { "enabled": true, "sessions": ["*"],
  "codexFork": { "enabled": true, "sessions": ["<full thread id>"], "platforms": ["darwin"],
                 "idleAfterSeconds": 90, "maxAnswerBytes": 4096 } }
```

Absent means off. The daemon reads the policy at every exchange round (every 2
seconds) and applies it to that round, the exchange's send gate included: adding or removing `wake.codexFork`, or
an owner in `wake.sessions` or `codexFork.sessions`, takes effect at the next
round without a daemon restart (issue #444). Only full thread ids are accepted (in any case, kept in
lowercase), never `*` or a name, and
only `darwin`. Windows was measured and stays off (issues #464, #477): the helper's process tree
cannot be proven contained, and a forced close cannot confirm the helper's process tree once the
helper has exited (`taskkill /T` needs a living root), so an attempt whose close is forced after the
helper exited keeps the service admission lease. A turn timeout on a living root measured exactly
that: `uncertain/close-unconfirmed` with the lease kept. The fork itself completes on Windows
(Codex CLI 0.160.1, a Desktop-created owner): the `-32600` refusal first measured in #464 came from
the measurement probe, which passed one MCP server override that codex rejects; the production fork
guards drop such names (`computeOverrides`). Enabling Windows needs the per-descendant identity
kill of the stop path (issue #231) in the fork and a containment capture from creation on, a
separate change. Any other shape turns off
only the fork reply; waking stays as written. The node already records one
attempt per message and decides admission (opt-in, kill switch, enrollment,
policy unchanged, recorded non-task owner, permission mode, platform, the Codex
delivery hook on `PostToolUse`, idle evidence, an accepted exact-addressed
message below the reply depth, no earlier attempt, a working directory inside
the workspace roots, readiness and the shared turn budget). The owner's recorded
`cwd` must lie inside `sessions.workspaceRoots`, with `sessions.enabled` and
`codex` in `sessions.runtimes`; the fork loads `AGENTS.md` from that directory,
so an owner started outside the approved roots is refused `cwd-refused` at
every attempt. With the section
present on `darwin`, the daemon starts one short-lived `codex app-server` (the
`codex` on `PATH`, run directly, in its own process group, with
`KHEREP_CODEX_FORK=1`) per eligible message, one at a time on the node. It
reads the owner without loading it (`thread/read`; the newest turn through
`thread/turns/list`, which must be `completed`; and `thread/goal/get`, which
must show no goal or a complete one). It then forks the idle owner ephemerally
at that turn with tools, hooks, goals, web search, request-user-input and every
discovered MCP server off. `deferGoalContinuation` is never sent: it cannot be
combined with an ephemeral fork, and it copies the goal into a persisted one.
The fork is driven only after `thread/goal/get` on it answers `-32600` with
exactly `ephemeral thread does not support goals: <fork id>`, the server's
statement that the fork cannot hold a goal; any other answer, `goal: null`
included, fails the attempt. Both goal reads need goals enabled in the Codex
config of the identity (the default): with goals disabled the helper cannot
read the owner's goal, and every attempt refuses `goals-disabled` after its
admission. No version or hash of `codex` is pinned: an upgrade that answers the
same way keeps working, and one that answers differently fails visibly with a
fixed reason code.
The fork gets one bounded structured question; the daemon validates the answer
and stores it in `codex-fork-attempts/<owner>/<message>.json`. A JSON-RPC error
response to `initialize`, `thread/read`, `thread/turns/list` or `thread/fork`
is recorded only as one content-free daemon log line (issue #477):
`kherep-node: Codex fork helper refused <method> (code <code|none>, <shape>, sha256 <12 hex>, mentions <list|none>)`,
with the code only when it is an integer, the shape `missing`, `empty`, `text`
or `overlong` (over 4096 UTF-8 bytes), the first 12 hex digits of the SHA-256
of the message, and which of the owner id, the newest turn id, the working
directory, the Codex home and the word `kherep` the message contains. No text
of the server's message is kept anywhere, and no persisted field is added: the
attempt keeps its reason code as before, `wake.jsonl` and the relay are
unchanged, and a code alone names no cause. Any approval or
other request from the server, a tool item, a goal change or a turn the helper
did not start fails the attempt. The owner's inbox record, progress, session
record and thread are untouched; the owner's next turn reads the message as
before. Each attempt writes one
`wake.jsonl` line (`fork`, `fork-declined`, `fork-failed`, `fork-uncertain`,
`fork-superseded`). Every refusal before the claim is one `wake.jsonl` line per
owner, message and code (issue #444): `fork-disabled-platform`, `fork-not-idle`,
`fork-cwd-refused`, `fork-permission-mode`, `fork-budget-spacing` and so on (the
admission code with the prefix `fork-`), and the producer's own `fork-producer`,
`fork-mcp-unknown`, `fork-features-unknown` and `fork-relay-unsupported`. A line
carries ids and the code only, never a path or text. A line whose append failed
is not marked as noted: the next poll that meets the same refusal writes it
again once the audit file is writable. On another platform the only effect is the
`fork-disabled-platform` line. The fork spends the owner's turn budget once per
attempt. A non-interactive `codex exec` session reports `approval_policy=never`
to the hooks even with `-a on-request` and `--sandbox read-only` (measured
2026-10-16, codex-cli 0.160.1), so its record carries `permissionMode:
bypassPermissions` and admission refuses it (`fork-permission-mode`); fork
owners are interactive sessions (TUI or Desktop). `kherep-node doctor` prints the section with a count of opted-in
sessions and counts the attempts per state.

Relay of a completed answer (issue #408, fourth increment). The daemon's sweep,
in every poll before the inbox filter, writes one outbox record per completed
attempt: a proxy answer to the original's sender, from the owner's session, with
`proxyOf` naming the original, never `inReplyTo`, so the original is never
marked replied, and with the original's reply depth plus one. Its text starts
with a fixed header that names the owner session, the fork and the original and
says the owner has not read the message yet. There is no stored release: the
sweep writes the record only when the relay guards pass, and the exchange runs
the same guards again at every send, resends included, so a guard that fails
after the write holds the record from the next exchange round on. The guards,
in order: the attempt at most 24 hours old (`fork-relay-stale`); the policy read
fresh (the section present, enrolled, no kill switch, the fingerprint the
attempt was admitted under, the owner opted in, the platform, the answer within
`maxAnswerBytes`); the Worker capability `messaging.proxy.v1` proven by a
directory frame of the current authenticated connection (cleared at every close
and every authentication, never read from `directory.json`); the original still
`accepted` for the owner; and the owner's recorded session with admission's own
clauses (recorded and recent, not a task session, no bypass or unknown
permission mode, the `PostToolUse` hook, idle evidence). A relay spends no turn
and starts no helper. The send also needs the message's sidecar
`inbox/proxied/<message>.json` to match the attempt, the relay id and the fork;
a missing, unreadable or mismatched one holds the record. A Worker without the
capability refuses every fork before admission (`fork-relay-unsupported`).

When the owner reads or answers first, the daemon withdraws before any send guard
is consulted, in every poll for every message with a sidecar, whatever the
owner's session state and whether or not `wake.codexFork` is present (the
`fork-superseded` audit line only while it is): exactly (outbox record and
sidecar removed) when no frame can have left this node, and otherwise as
unconfirmed, keeping the record (never sent again) for a late Worker status. A
held record that gets no Worker status within 24 hours is removed by the same
per-poll bookkeeping (a missing sidecar is not recreated, one naming another
relay is left as it is, and a record that is not the attempt's relay is never
removed); the sidecar then records `unresolvedAt`, and the outcome is
unknown, not "not delivered": a later status is acknowledged and not recorded
locally, and the Worker's message listing and audit may hold it. The Worker
refuses a proxy whose original row is missing or does not match (`proxy parent
unknown`, also for a deleted original with a tombstone), is answered
(`original already answered`) or is not `accepted` (`original not waiting`), and
beyond the reply depth. The owner's reply, and the owner node's `delivered` or
`refused` report of the original, refuse every proxy of it still queued; a
delivery frame produced before that is dropped where it is pushed. A proxy
already accepted at the peer stays: the peer then holds both the proxy and the
owner's reply (audit `message.proxy.late-delivery` when a refused proxy is
reported taken); closing that needs a reservation (a later increment).

`relayedAt` in the attempt means the control plane answered the relay (its first
status in `sent/`), and the attempt is audited `fork-relayed`. The owner's next
delivery and `msg inbox` show one line per state, derived from the sidecar, the
outbox and `sent/`: prepared and not queued; queued locally or awaiting
confirmation; may have reached the control plane; queued by the control plane;
reached the peer (the only line that says not to answer again); could not be
delivered (with the quoted reason); and no delivery status before local cleanup
(outcome unknown). The proxy's own sent record produces no failure or receipt
notice for the owner. The peer sees `Proxy answer for your message <id>` and
`msg inbox` prints `proxy for: <id>`; its reply to the proxy is an ordinary
reply to the owner's session.

Measured on synthetic threads (2026-10-16, Codex 0.160.1 on `PATH`,
0.162.0-alpha.17.2 and 0.163.0): `thread/goal/get` answers `goal: null` for an
owner no server has loaded and the exact ephemeral refusal for a fork, both
answer "goals feature is disabled" with goals off, and a fork turn with the
output schema runs with no turn or goal event the helper did not start.

Measured on macOS, on synthetic threads only, with the real
`codex` on `PATH` (0.160.1), the bundled binary (0.162.0-alpha.17.2) and the
daemon's (0.163.0) and the existing login: the fork reply completes with no
server request and no authentication request; a long rollout (1.7 MB) forks;
with `features.hooks=false` the fork adds no hook event; a synthetic
Desktop-created owner is declined (`needs-owner`) with its rollout unchanged;
MCP servers start for the fork. No real chat belongs in `codexFork.sessions`.
Still open are goal isolation with an active goal set on the owner; a fork of
an owner loaded by the Desktop app and the absence of a new chat or Queue card
in its UI; the Desktop stop button; the native renewal of the login; the real
model catalog and plugins as a separate measurement; and an installed daemon
with the fork switched on. The fork stays `darwin` only (measured in issues #464 and #477): on
Windows the fork completes, but `taskkill /T` cannot reach the descendants of a
helper that already exited, so the close there is never confirmed and the
lease is kept.

Admission and a metadata claim leave messages `accepted`. Explicit
`msg inbox --receive` offers only the messages actually returned; normal confirming
Stop marks those `offered` records `delivered`. An interrupt does not confirm them.
Messages outside the ticket or a limited Receive remain in the CP Inbox under
its existing retention contract. The normal prompt/Stop intake remains available.

After confirming delivery, normal Stop awaits bounded cleanup of exact native
pointer groups. Every member must be delivered to the original owner; the Queue
ID, full input, local producer binary/hash and Codex home must match. Public
list/delete and a complete readback establish removal. Attempts remain durable
duplicate barriers. Offered, uncertain, partial and foreign cards are retained.
Late producer settlement and existing daemon polls recover pending cleanup,
including already-delivered pointers after wake is disabled. No new model turn
is started by cleanup. A pointer already claimed, or admitted after Stop before
its ID is known, may already have started a turn; cleanup does not interrupt it.

Separate `.busy-admission.json` metadata records the authorized generation and
publication time; old `.queued.json` history never authorizes or blocks CP hints.
Successful publication waits up to ten minutes for intake. If still accepted
then, fresh admission rechecks guards without booking an autonomous turn. Claim
alone is no Receive. Publication failure or contention retries the same generation on
existing poll rounds without booking a turn while its TTL and policy are valid.
Policy drift or expiry invalidates that retry. Restart recovers valid CP metadata;
missing or unreadable metadata requires a fresh authorized admission. Native
attempts remain independent of hint retries. Progress is `waiting/awaiting-user-turn` while intake is
pending, `waiting/retry-pending` after publication failure and
`waiting/awaiting-turn-confirmation` after an actual offer.

Reinstall projects this separate PostToolUse definition even when the three older
intake hooks are externally owned. Review and trust the exact new definition in
Codex, restart the original owner, and test active peer processing at a supported tool boundary.
The installer stops before writes if an operator-owned PostToolUse group would
move to another positional trust key. It does not mint or move trust hashes.
Source and fixture tests alone do not establish either host's native acceptance.

An interactive Codex TUI on Codex 0.160 can write the same first rollout line as a
Desktop chat (measured on macOS, issue #268). The TUI marker and cached
shared-daemon probe still restrict the automatic `codexApp` grant: a positively
reachable TUI is excluded, and a marked candidate with unknown reachability waits
without admission bookkeeping. Full-id policy authorization permits CP admission
independently of that probe. The probe remains bounded to two seconds and cached
for ten seconds; Windows does not connect to that daemon socket.

The kill switch, full-id authorization or `codexApp` grant, permission-mode check
and reply-depth limit remain. CP hint admission and claim do not check or spend
the shared turn budget or spacing. Actual listener wakes and Stop continuations retain their existing
autonomous-turn gates.
App-grant decisions retain `"grant": "codexApp"` in the metadata-only wake audit.
Codex background tasks and genuinely closed targets retain their separate policy
paths; Claude delivery is unchanged. Source and synthetic tests do not establish
installation, hook trust or processing on either Desktop host. Actual owner-turn
acceptance is tracked in [issue #374](https://github.com/cfaysal/kherep/issues/374).

## Retired memory backend

Earlier installers could select a separate Central Brain MCP server with native context and capture hooks. That backend is retired; the Central Brain is now the Confluence knowledge space described above. A reinstall over such a host reads the persisted `orchestra/memory-provider.json`, resets it to `{ "provider": "unconfigured" }` with the previous file in the installation backup, and replaces the managed configuration block the old installer rendered, which removes its MCP table and native hooks. The receipt reports `retiredMemoryProvider: "central-brain"` for that run. A block that differs from what the old installer wrote is not overwritten; the installer stops and leaves it for review. A `central-brain` MCP table outside the managed block is removed only when it is exactly the table the old installer rendered for the persisted selection; otherwise it stays and the receipt lists it under `retiredMcpServers` as `retained-for-review`. A Codex project trust entry for the old `central-brain` checkout is an operator setting and stays untouched. An explicit `central-brain` selection is refused.

## Verify and upgrade

The installer manages routing, hooks, plugin registration and an installation receipt. It preserves unrelated settings and uses recoverable transactions.

The top-level `model_reasoning_effort` in `config.toml` belongs to you. If it is set, the installer keeps that line byte for byte. Only when it is absent does the installer write the default `model_reasoning_effort = "xhigh"`, which matches the Maestro's default root tier. A value inside a table such as `[profiles.<name>]` does not count as top-level and is never changed. The receipt records the outcome as `reasoningEffort`, with `status` `preserved-existing` or `configured` and the `value` kept or written.

After installation, restart Codex in the selected workspace. Check rule and plugin discovery, a harmless tool call and each configured MCP connection. A plugin entry alone does not establish a working connection.

Review and trust the exact hook definitions using the host's supported hook controls. Feature and administrator policies can prevent execution; installation does not override them. Inspect discovery and execution at the actual Desktop host, then verify a quiet observation turn as described above. Desktop hook support is UNKNOWN until this measurement. CLI discovery or a prepared output receipt alone does not prove delivery. See the [official Codex hook contract](https://developers.openai.com/codex/hooks).

For turn-completion observations, keep the following evidence separate:

On both hosts, inspect both `UserPromptSubmit` hooks and confirm that the `Stop` group contains the research and acceptance gates, with no observation hook. Then run one substantial synthetic turn without research and verify exactly one research continuation; repeat it with `stop_hook_active: true` and verify no second continuation.

The managed block also runs a hook-integrity check, `hooks/kherep-maestro/codex-hook-integrity.mts`, as the last entry of the Maestro `SessionStart` group. At every session start it checks each hook file `config.toml` wires under `<CODEX_HOME>/hooks` and the files they import. It restores a missing, empty or unparsable file from the Kherep checkout and counts the restore only when the bytes at the target match the checkout. It reports what it found in the session and appends each finding to `<CODEX_HOME>/.cache/hook-integrity/incidents.jsonl`; when everything is healthy it prints nothing. The two observation hooks the installer renders are only reported, and a reinstall repairs them. Without a resolvable checkout it writes nothing and reports the file as not restored. An upgrade from the previous projection appends this one entry and leaves every other entry at its position, so Codex marks exactly this new hook for review. Trust it with `/hooks`; until then the check does not run. Check the journal path after a test session if you need evidence that it ran.

The managed block also runs the control-plane delivery hook, `modules/control-plane/node/deliver-hook.mts --runtime codex`, for `SessionStart`, `UserPromptSubmit` and `Stop`, from the checkout or source pin the installer runs from. It hands messages from other agent sessions to the Codex session and is inert without an enrolled control-plane node. SessionStart and every UserPromptSubmit supply the session's exact receive recipe in bounded developer context, even with an empty inbox. Stop emits only `Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.` The CLI and escalation instructions remain in context; peer content and identifiers never enter this visible reason. Like every non-managed hook it runs only after you review and trust it in Codex. See [Codex sessions](../modules/control-plane/README.md#codex-sessions).

Since issue #503 no Control Plane hook command names that source. Codex trusts a hook by a hash over its definition, command line included, so a command naming `<CODEX_HOME>/orchestra/source-pins/<commit>` changed with every upgrade and asked for review again. The six definitions (shell-group and `PostToolUse` attribution, delivery on `SessionStart`, `UserPromptSubmit`, `Stop` and the `PostToolUse` busy hint) name the stable entry point and a fixed hook name instead: `"<node>" "--disable-warning=ExperimentalWarning" "<CODEX_HOME>/hooks/kherep-maestro/codex-control-plane-hook.mts" "deliver" "--runtime" "codex"`, `... "attribution" ...`, and for the shell group `"<node>" ".../codex-shell-checks.mts" ".../codex-control-plane-hook.mts" "attribution" "--runtime" "codex"`; `commandWindows` is the same with `& ` in front. The Node flag applies to the entry point only: on the Node versions that print a type-stripping warning, a hook run then shows the stderr of a direct hook call, and every warning of the hook itself still shows. The shell dispatcher loads the entry point in-process and needs no flag. The installer writes `<CODEX_HOME>/orchestra/control-plane-source.json` (`version` 1, the absolute source `root`, its `commit` when known, `kind` `pin` or `checkout`, `verified`) inside its install transaction, so a failed install or a rollback restores the previous record with the rest. The entry point accepts only `deliver` and `attribution`, never a path. It checks the record's shape, that `<root>/modules/control-plane/node/<hook>` is a file and, for a pin, that `<root>/.kherep-source.json` exists, then runs that hook with the same Node executable as its own process, with the caller's stdin, stdout, stderr, environment and working directory, and passes its exit code on. Without a usable record it exits 1 with one stderr line naming the record and `codex/install.mts`, and never falls back to its own directory, the working directory, the workspace, `PATH` or the service receipt. This per-run check is not a verified load: `kherep-node doctor` verifies the source identity behind the record. The service launcher's receipt stays the service's own record; the Codex installer writes only this one.

The receive recipe and short feedback have separate source pins. A source merge does not activate them. Before switching a referenced checkout to short feedback, verify the actual stage-A context boundary in every affected original owner and finish any pre-A turn. A new chat, installation receipt or harness receive is insufficient. Live hook installation and same-owner Desktop acceptance remain separate from this source change; see the [cutover plan](superpowers/plans/2026-10-10-codex-quiet-owner-cutover.md).

The `<!-- kherep:start -->` block of `<CODEX_HOME>/AGENTS.md` and `orchestra/ROUTING.md` name the host's intercom command, `node "<config dir>/bin/kherep-node.mjs"` (issue #436, see [Intercom command](INSTALLATION.md#intercom-command)); the installer renders it from the config dir of the outbox below, and the text outside the block keeps its bytes.

So that a Codex session can answer peers without an approval per message (issue #72), the installer also writes the rule file `rules/kherep-control-plane.rules`, which allows only the `msg send`, `msg sessions`, `msg inbox` and `msg status` subcommands of the control-plane CLI. It holds one `prefix_rule`, for the intercom command: `node` with `<config dir>/bin/kherep-node.mjs` in forward slashes, the command the daemon's task prompt, the delivery hook's recipes and the instructions name on a host with a managed service (issue #436). The rule for the checkout's `modules/control-plane/node/cli.mts` that earlier installs wrote is gone, and a reinstall rewrites the whole file. Upgrade the service first (`kherep-node service upgrade` to a pin with this change), then run this installer; until then `kherep-node doctor` reports the old rules file as `stale`. The installer also makes the node outbox (`<config dir>/control-plane/outbox`, where the config dir is `KHEREP_CONFIG_DIR` or the per-OS location) an extra writable root of the `workspace-write` sandbox through `sandbox_workspace_write.writable_roots`. The node directory itself, with its key and `policy.json`, stays read-only. TOML allows one `[sandbox_workspace_write]` table, so where the outbox goes depends on your `config.toml`:

- No `sandbox_workspace_write` of yours: the managed block carries `[sandbox_workspace_write]` with `writable_roots = ["<outbox>"]` and owns it.
- Your own `[sandbox_workspace_write]` table or top-level `sandbox_workspace_write.*` keys (anywhere outside the managed block): the managed block carries no table, and the installer appends the outbox to your `writable_roots`, or adds that key when it is missing. It never removes an entry of yours, and a reinstall that finds the outbox already listed changes nothing. If you later drop your table, the next install moves the outbox back into the managed block; an outbox path from an older config directory stays in your list until you remove it.
- An inline table (`sandbox_workspace_write = { ... }`), a `writable_roots` value that is not a plain array of strings, or `default_permissions` (which the configuration reference says not to combine with `[sandbox_workspace_write]`): the installer leaves your text byte-identical and writes nothing for the outbox. The first `msg send` of a session then needs the escalated retry, as before.

The receipt records the outcome as `controlPlaneOutbox.status`: `managed`, `operator-merged`, `operator-present`, `skipped-inline-table`, `skipped-unparseable` or `skipped-default-permissions`. The root takes effect only when `sandbox_mode = "workspace-write"`.

A Codex session's `msg send` needs no `--from` when `CODEX_THREAD_ID` is in its shell environment and the CLI can determine the runtime that runs the command. Codex sets the variable for its shell commands (source-defined, not named in the Codex docs; measured with Codex 0.160.1 on macOS, Windows unmeasured). The sender check distinguishes three evidence cases (issues #471 and #489, see [CLI](../modules/control-plane/README.md#cli)):

- Only `CODEX_THREAD_ID` is set, without `CLAUDE_CODE_SESSION_ID`: the thread is the sender; the process ancestry is not needed.
- Both `CODEX_THREAD_ID` and an inherited `CLAUDE_CODE_SESSION_ID` are set, as for a `codex exec` started from a Claude Code tool or a `claude -p` started from a Codex tool: a complete, recognisable process ancestry decides the runtime, in either nesting direction.
- Both are set and the available process ancestry does not establish the nesting: an implicit send is refused with the fixed `NESTED_RUNTIME` reason and nothing is written. `--from` is then accepted only when it is the full id of a Codex session a Kherep hook recorded within 12 hours and, if `KHEREP_SESSION_ID` is set, that task records the same thread. Without such a record the send stays refused, even when `--from` repeats `CODEX_THREAD_ID`; otherwise use an authorized command context where the runtime can be determined. A fresh record does not mean that the separate outbox filesystem access succeeds.

These cases describe the sender check, not how a particular command was executed: the rule file and sandbox configuration described above do not by themselves establish which rule applied to a command, which permissions it ran with or how much process ancestry it could read. Which conditions leave the ancestry undecided on a given platform is not measured.

Measured on Windows on 2026-09-27: the Codex desktop app does not apply this root. Without `sandbox_mode` in the config, an app thread runs under a managed `:workspace`-style permission profile (workspace, temp, the thread's visualizations folder), and `msg send` fails with `EPERM` on the outbox. A `default_permissions` profile that adds the outbox did not reach an existing thread after a restart either, so the installer does not write one. What works in the app is the rule file: an escalation request for the `msg` command runs outside the sandbox without asking. The delivery hook's context therefore tells a Codex session to request escalation for the `msg` command on the first attempt; measured, a woken app thread then answered with no user action. The writable root still serves `codex exec` runs.

1. **Configured target and readback:** confirm the installed `codex-obs` role, the quiet context reminder and acceptance-only Stop entry, the twelve required files in `<workspace>/tools` and the canonical JSON fields. Run `node <workspace>/tools/atl-confluence.mts space --space <spaceKey>` and compare its returned identity with the canonical file. This proves configured discovery and a service-account read, not a write or automatic dispatch.
2. **Manual one-observation write:** dispatch one bounded `codex-obs` pass for a completed turn that contains one durable finding. Validate its JSON candidate, then publish it from the trusted Maestro main thread. Verify the create receipt, target space, labels and service-account author through the broker's independent readback. A worker result or dispatch report without target readback is insufficient.
3. **Manual zero-write:** run a separate completed turn with no durable finding. Require exactly `{ "observations": [] }`, no broker write and independent evidence that the run created no page. A failed, skipped or unobserved run is UNKNOWN, not zero observations.
4. **Automatic quiet dispatch:** complete a normal main-thread turn without manually invoking `codex-obs`. Verify that the trusted context hook ran, exactly one observation pass occurred before final, and no observation prompt appeared in the chat. Manual success and installed source do not prove this step.
5. **One pass only:** verify that an observation worker run does not trigger another observation run.

Installed hook trust is a prerequisite for steps 4 and 5. Live Windows acceptance remains UNKNOWN until these checks are measured on the actual target; repository tests and configured source are regression evidence only.

Before an upgrade, compare source and managed target files in both directions and review operator edits. Retain the transaction backup and verify recovery in a disposable candidate.

An upgrade may run from another checkout or source pin than the installation it replaces, for example `<CODEX_HOME>/orchestra/source-pins/<commit>`. A block an installer before issue #503 wrote names that directory before the control-plane `deliver-hook.mts` and `attribution-hook.mts`, also as the shell dispatcher's argument, and possibly an earlier Node executable. The installer treats such a block as its own, also when the Codex app has split it around its trust tables, rewrites those commands once to the stable entry-point form and the Node it runs with, and updates the source record; Codex then asks for one review of the six definitions, and later upgrades leave them byte-identical. Exact external delivery groups outside the block keep sole ownership in the stable form and in the old form bound to the installing source; they are never rewritten. Such an old-form group names the installing source's own path, so it stops matching after the next change of checkout or source pin, and the managed block then renders its own delivery groups next to it; `kherep-node doctor` reports these commands under `codex.legacy`. Replace them with the stable form, or remove them, before that upgrade. Any other difference in the block is still refused. On a host, run `kherep-node service upgrade` as before, then this installer once from the new source. `kherep-node doctor` counts a hook that names a source pin of the checked-out commit as this checkout and lists it under `pinned`; a pin or checkout of another commit, one with tracked changes, a missing pin or a path that is not a hook of such a source still fails the hook check; since issue #445 a hook in a checkout whose source identity matches the pin the doctor runs from counts as well and is listed under `checkouts`. A pin's commit is its git `HEAD` where it has one, otherwise its directory name. A Codex command in the stable form counts only through this home's entry point and the deliver hook its source record names; the record's state is reported as `codex.pointer` (`valid`, `missing`, `invalid`, `unresolved`), with `codex.stable` and `codex.legacy` (commands still in the path form, until the next install rewrites them). A stable command with an unusable record fails the hook check.

For source changes, run `npm run typecheck` and `npm run test:codex`. Keep skips and unavailable integration checks separate from passing results.
