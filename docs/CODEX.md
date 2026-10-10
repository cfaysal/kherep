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

The native `research-first` prompt hook emits a fixed local instruction and no prompt text. The `research-stop` hook reads only the absolute local Codex rollout path in the Stop payload, rejects Claude-private paths, and examines the latest matching `task_started` turn. It accepts direct `function_call` and `custom_tool_call` records, including the hyphenated and underscored codebase-memory server names. A local lexer also recognizes actual `tools.*(...)` call syntax inside `functions.exec`, including records with separate `name: "exec"` and `namespace: "functions"` fields. Bare `exec` and other namespaces do not count as this wrapper. Quoted examples, comments, template literals and regular-expression literals in the supported JavaScript contexts do not count. User messages and tool output never count. Dynamically constructed JavaScript remains outside this classifier. This lexical evidence records an attempted call only. It does not prove that a conditional branch ran, that a lookup succeeded, or that the result supports the answer.

A substantial turn must show a Central Brain lookup attempt. A detected repository change through `apply_patch`, an explicit file-write tool or a common shell mutation command also requires a codebase-memory call. Arbitrary shell programs can hide file mutations from this classifier. A final `[research: none - <reason>]` with a nonempty reason opts out. The Stop hook blocks only when `stop_hook_active` is exactly false, so its continuation cannot loop. It emits fixed text and never emits transcript content or performs network I/O.

A wholly malformed, unreadable, relative, Claude-private or unrecognized transcript is undecidable and fails open. A malformed trailing line is ignored when earlier records still identify and describe the requested current turn. Codex's rollout format is unstable, so an undecidable read is documented rather than treated as evidence that research was absent. Under the [official Codex Stop hook contract](https://learn.chatgpt.com/docs/hooks?translationFallback=de-DE), a matching `continue: false` result takes precedence over continuation decisions. If the acceptance gate rejects the same stop, Codex stops on that result and does not surface the research continuation. The research gate therefore enforces the once-only continuation when acceptance allows stopping.

The source check named research parity covers only `research-first.mts` and `research-stop.mts` in the Claude and Codex adapters. It fails if one of those four source files is missing. It does not establish general Claude/Codex parity. Repository tests establish source behavior and projected configuration. Whether a particular Desktop host trusts and executes both hooks remains UNKNOWN until the installed target is inspected and a missing-research turn is observed there.

This minimal graph does not enable the broader Atlassian surfaces. `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is the explicit opt-in for the Codex Jira graph, the Claude Jira and Confluence broker copies, and the managed v2 Atlassian remote MCP server `atlassian` (`https://mcp.atlassian.com/v2/mcp`). An operator's own `atlassian` table outside the managed block is preserved. The v1 `rovo` table is retired, and the installer no longer registers the legacy `atlassian-rovo@openai-curated` plugin; a registration from an earlier install stays until the operator removes it. The Claude bootstrap installer places both Confluence brokers by default, because it installs `claude-obs`. Codex and Claude brokers continue to use separate service-account credential bindings.

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

A Codex desktop app restart starts a new session with a new id, so a `wake.sessions` list of full ids stops matching the session the operator works in. The optional node policy field `wake.codexApp` (boolean, default `false`) adds one grant for it:

```json
"wake": { "enabled": true, "sessions": [], "codexApp": true }
```

With `codexApp: true` the list may be empty or absent. Any non-boolean value turns waking off, as a malformed list does. The grant selects exactly one Codex session that the list does not name: the most recently seen session recorded by the delivery hook whose rollout, `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, begins with a `session_meta` line for that id with `originator` `"Codex Desktop"` and `source` `"vscode"`, and no parent thread. The node reads that line itself. It searches the newest 62 date directories, reads at most 256 KiB, follows no links and refuses a missing, unreadable or garbled file or any other value. Exec runs, Codex tasks and app subagent threads are never granted. If two app sessions share the latest time, neither is granted. A TUI reachable on the shared app-server daemon (below) is never granted and is skipped when the newest app session is chosen.

An eligible Desktop or Terminal session receives `codex queue --thread <full id> --message "Kherep: <n> peer message(s) waiting in your inbox."`. The existing runtime consumes the persistent queue; the producer never resumes its thread. Peer text stays in the original inbox until trusted `UserPromptSubmit`, `Stop` or explicit receive processing offers it. Only the existing confirming turn or threaded-reply path confirms delivery. Even with `messaging.resumeClosed: true`, this path does not redirect the message to an intercom task. A successful queue command alone is not a wake or delivery confirmation. An unloaded owner may leave the input pending.

Each synchronous Codex queue round reads, parses and indexes the full Inbox once after it has found eligible non-task owners. Before it applies the queue guards, a decision rereads only the indexed message records for that owner's full id and aliases. Its existing attempt-ledger cleanup may still list Inbox filenames per owner, but it does not reparse unrelated records. A record already deleted, consumed or readdressed at that targeted read is excluded. This read is not an atomic lock against a later change during the same decision. Messages that arrive after the snapshot remain for the next eligible round. The index is discarded at the end of the round.

An interactive Codex TUI on Codex 0.160 can write the same first rollout line as a Desktop chat (measured on macOS, issue #268). The TUI marker and cached shared-daemon probe still restrict the automatic `codexApp` grant: a positively reachable TUI is excluded, and a marked candidate with unknown reachability waits with `awaiting-user-turn`, without consuming budget or recording an attempt. Regular policy authorization permits queue independently of that probe. The probe remains bounded to two seconds and cached for ten seconds; Windows does not connect to that daemon socket. None of these observations is a delivery receipt.

The kill switch, full-id authorization or `codexApp` grant, permission-mode check and reply-depth limit still apply. Queue attempts consume the shared turn budget and spacing. At most one attempt is recorded per message, including after failure or timeout; an uncertain submission is not automatically retried. Decisions made under the app grant are written to `wake.jsonl` with `"grant": "codexApp"`. Genuinely closed targets retain the separate closed-session policy. Claude's wake path is unchanged.

Issue #367 independently verified original Windows Desktop wake with CLI 0.160.1 and the Desktop embedded CLI 0.162.0-alpha.17.2. These are tested versions, not a universal minimum-version guarantee. The producer must share the owner's Codex home and persistent store, and the owner must support consuming externally queued input. Older CLI 0.157.1 only produced a pending Steer item in the earlier measurement. macOS original-Desktop acceptance remains open; a headless probe was denied before submission and therefore did not test the consumer. See the [runtime evidence](https://github.com/cfaysal/kherep/issues/367#issuecomment-6089997175).

A Codex intercom fallback that fails because its configured model is unavailable for the account refuses its linked message with a fixed reason instead of retrying the same failure three times. Other failures retain bounded retries. The status identifies an exhausted fallback separately from a missing confirmation in the original session; raw CLI error text is not copied into message status.

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

The managed block also runs the control-plane delivery hook, `modules/control-plane/node/deliver-hook.mts --runtime codex`, for `SessionStart`, `UserPromptSubmit` and `Stop`, from the checkout the installer runs from. It hands messages from other agent sessions to the Codex session and is inert without an enrolled control-plane node. Like every non-managed hook it runs only after you review and trust it in Codex. See [Codex sessions](../modules/control-plane/README.md#codex-sessions).

So that a Codex session can answer peers without an approval per message (issue #72), the installer also writes the rule file `rules/kherep-control-plane.rules`, which allows only the `msg send`, `msg sessions`, `msg inbox` and `msg status` subcommands of the control-plane CLI, and makes the node outbox (`<config dir>/control-plane/outbox`, where the config dir is `KHEREP_CONFIG_DIR` or the per-OS location) an extra writable root of the `workspace-write` sandbox through `sandbox_workspace_write.writable_roots`. The node directory itself, with its key and `policy.json`, stays read-only. TOML allows one `[sandbox_workspace_write]` table, so where the outbox goes depends on your `config.toml`:

- No `sandbox_workspace_write` of yours: the managed block carries `[sandbox_workspace_write]` with `writable_roots = ["<outbox>"]` and owns it.
- Your own `[sandbox_workspace_write]` table or top-level `sandbox_workspace_write.*` keys (anywhere outside the managed block): the managed block carries no table, and the installer appends the outbox to your `writable_roots`, or adds that key when it is missing. It never removes an entry of yours, and a reinstall that finds the outbox already listed changes nothing. If you later drop your table, the next install moves the outbox back into the managed block; an outbox path from an older config directory stays in your list until you remove it.
- An inline table (`sandbox_workspace_write = { ... }`), a `writable_roots` value that is not a plain array of strings, or `default_permissions` (which the configuration reference says not to combine with `[sandbox_workspace_write]`): the installer leaves your text byte-identical and writes nothing for the outbox. The first `msg send` of a session then needs the escalated retry, as before.

The receipt records the outcome as `controlPlaneOutbox.status`: `managed`, `operator-merged`, `operator-present`, `skipped-inline-table`, `skipped-unparseable` or `skipped-default-permissions`. The root takes effect only when `sandbox_mode = "workspace-write"`.

Measured on Windows on 2026-09-27: the Codex desktop app does not apply this root. Without `sandbox_mode` in the config, an app thread runs under a managed `:workspace`-style permission profile (workspace, temp, the thread's visualizations folder), and `msg send` fails with `EPERM` on the outbox. A `default_permissions` profile that adds the outbox did not reach an existing thread after a restart either, so the installer does not write one. What works in the app is the rule file: an escalation request for the `msg` command runs outside the sandbox without asking. The delivery hook's context therefore tells a Codex session to request escalation for the `msg` command on the first attempt; measured, a woken app thread then answered with no user action. The writable root still serves `codex exec` runs.

1. **Configured target and readback:** confirm the installed `codex-obs` role, the quiet context reminder and acceptance-only Stop entry, the twelve required files in `<workspace>/tools` and the canonical JSON fields. Run `node <workspace>/tools/atl-confluence.mts space --space <spaceKey>` and compare its returned identity with the canonical file. This proves configured discovery and a service-account read, not a write or automatic dispatch.
2. **Manual one-observation write:** dispatch one bounded `codex-obs` pass for a completed turn that contains one durable finding. Validate its JSON candidate, then publish it from the trusted Maestro main thread. Verify the create receipt, target space, labels and service-account author through the broker's independent readback. A worker result or dispatch report without target readback is insufficient.
3. **Manual zero-write:** run a separate completed turn with no durable finding. Require exactly `{ "observations": [] }`, no broker write and independent evidence that the run created no page. A failed, skipped or unobserved run is UNKNOWN, not zero observations.
4. **Automatic quiet dispatch:** complete a normal main-thread turn without manually invoking `codex-obs`. Verify that the trusted context hook ran, exactly one observation pass occurred before final, and no observation prompt appeared in the chat. Manual success and installed source do not prove this step.
5. **One pass only:** verify that an observation worker run does not trigger another observation run.

Installed hook trust is a prerequisite for steps 4 and 5. Live Windows acceptance remains UNKNOWN until these checks are measured on the actual target; repository tests and configured source are regression evidence only.

Before an upgrade, compare source and managed target files in both directions and review operator edits. Retain the transaction backup and verify recovery in a disposable candidate.

For source changes, run `npm run typecheck` and `npm run test:codex`. Keep skips and unavailable integration checks separate from passing results.
