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

Review a disposable candidate before replacing an existing setup. The CLI supports these options, each with a value:

| Option | Purpose |
| --- | --- |
| `--workspace` | Workspace in which Kherep applies |
| `--codex-home` | Destination Codex configuration home |
| `--claude-config-dir` | Shared Claude dependency/configuration home |
| `--mcp-registry` | Absolute path to your source MCP registry |
| `--memory-provider-config` | Absolute path to explicit memory-backend selection JSON; only `{ "provider": "unconfigured" }` is accepted |

Both entry points run `codex/install.mts`, so the two host-owned values it needs are resolved by the same run whichever one you use: the Confluence knowledge space for this host, written to `kherep/confluence.json` in the resolved Codex home, and the Atlassian service-account credential. Each prompts only when a terminal is attached and otherwise fails with the variable named, so a scripted install does not block on stdin. If either is missing the parity installation above it still stands, and the observation agent writes nothing until the space file exists.

Keep private registry configuration outside the checkout. Read [adapter architecture](../codex/ARCHITECTURE.md) for supported transport, authentication and backend-selection formats.

## Turn-completion observations

On both hosts, the managed `Stop` group retains the acceptance gate but no longer requests an observation continuation. The `UserPromptSubmit` context hook gives the Maestro a short, quiet turn reminder to dispatch `codex-obs` before its final response. This avoids the user-visible `Stop` hook feedback that older installations showed as a new prompt. A reinstall replaces the exact old macOS and Windows managed Stop projections; their old script files may remain in the installation but are not configured as hooks.

The normal Codex projection installs `codex-obs`, rendered from the Codex-only worker definition `codex/agents/codex-obs.md`, and the minimal ten-file service-account Confluence graph in `<workspace>/tools`. The graph contains the Codex `atl-confluence.mts` broker, the shared `atlassian-credentials.mts` parser and the eight `confluence-*` modules for contract, content, session, related-page search, semantics, neighbours, neighbour CLI and runtime labels.

The Maestro dispatches `codex-obs` once with `fork_turns: "none"` and a bounded nonprivate turn summary. The worker performs no configuration or broker I/O and returns one strict JSON candidate envelope. Its projected role uses `sandbox_mode = "read-only"`; restricted subagent execution also does not grant it the Maestro's escalated network authority. Each candidate contains exactly `title`, `bodyStorage`, `evidence`, `labels` and `placement`; placement contains only `project` and `app`, while labels contain only `type-observation`, `evidence-<value>` and `status-author-model`. The trusted Maestro validates the result and adds session or runtime details during publication. An empty `observations` array performs zero writes. For nonempty candidates, the Maestro checks canonical publication authority and runs related-page search, create/readback and stitch through the Codex broker. The context hook forwards no prompt or transcript content. Hook configuration and tests establish the projected flow; verify actual dispatch and delivery on each Desktop host separately.

This minimal graph does not enable the broader Atlassian surfaces. `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is the explicit opt-in for the Codex Jira graph, the Claude Jira and Confluence broker copies, and Rovo registration. The Claude bootstrap installer places both Confluence brokers by default, because it installs `claude-obs`. Codex and Claude brokers continue to use separate service-account credential bindings.

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

## Retired memory backend

Earlier installers could select a separate Central Brain MCP server with native context and capture hooks. That backend is retired; the Central Brain is now the Confluence knowledge space described above. A reinstall over such a host reads the persisted `orchestra/memory-provider.json`, resets it to `{ "provider": "unconfigured" }` with the previous file in the installation backup, and replaces the managed configuration block the old installer rendered, which removes its MCP table and native hooks. The receipt reports `retiredMemoryProvider: "central-brain"` for that run. A block that differs from what the old installer wrote is not overwritten; the installer stops and leaves it for review. A `central-brain` MCP table outside the managed block is removed only when it is exactly the table the old installer rendered for the persisted selection; otherwise it stays and the receipt lists it under `retiredMcpServers` as `retained-for-review`. A Codex project trust entry for the old `central-brain` checkout is an operator setting and stays untouched. An explicit `central-brain` selection is refused.

## Verify and upgrade

The installer manages routing, hooks, plugin registration and an installation receipt. It preserves unrelated settings and uses recoverable transactions.

After installation, restart Codex in the selected workspace. Check rule and plugin discovery, a harmless tool call and each configured MCP connection. A plugin entry alone does not establish a working connection.

Review and trust the exact hook definitions using the host's supported hook controls. Feature and administrator policies can prevent execution; installation does not override them. Inspect discovery and execution at the actual Desktop host, then verify a quiet observation turn as described above. Desktop hook support is UNKNOWN until this measurement. CLI discovery or a prepared output receipt alone does not prove delivery. See the [official Codex hook contract](https://developers.openai.com/codex/hooks).

For turn-completion observations, keep the following evidence separate:

On both hosts, inspect the `UserPromptSubmit` context hook and confirm that the `Stop` group contains the acceptance gate and no observation hook.

The managed block also runs the control-plane delivery hook, `modules/control-plane/node/deliver-hook.mts --runtime codex`, for `SessionStart`, `UserPromptSubmit` and `Stop`, from the checkout the installer runs from. It hands messages from other agent sessions to the Codex session and is inert without an enrolled control-plane node. Like every non-managed hook it runs only after you review and trust it in Codex. See [Codex sessions](../modules/control-plane/README.md#codex-sessions).

1. **Configured target and readback:** confirm the installed `codex-obs` role, the quiet context reminder and acceptance-only Stop entry, the ten required files in `<workspace>/tools` and the canonical JSON fields. Run `node <workspace>/tools/atl-confluence.mts space --space <spaceKey>` and compare its returned identity with the canonical file. This proves configured discovery and a service-account read, not a write or automatic dispatch.
2. **Manual one-observation write:** dispatch one bounded `codex-obs` pass for a completed turn that contains one durable finding. Validate its JSON candidate, then publish it from the trusted Maestro main thread. Verify the create receipt, target space, labels and service-account author through the broker's independent readback. A worker result or dispatch report without target readback is insufficient.
3. **Manual zero-write:** run a separate completed turn with no durable finding. Require exactly `{ "observations": [] }`, no broker write and independent evidence that the run created no page. A failed, skipped or unobserved run is UNKNOWN, not zero observations.
4. **Automatic quiet dispatch:** complete a normal main-thread turn without manually invoking `codex-obs`. Verify that the trusted context hook ran, exactly one observation pass occurred before final, and no observation prompt appeared in the chat. Manual success and installed source do not prove this step.
5. **One pass only:** verify that an observation worker run does not trigger another observation run.

Installed hook trust is a prerequisite for steps 4 and 5. Live Windows acceptance remains UNKNOWN until these checks are measured on the actual target; repository tests and configured source are regression evidence only.

Before an upgrade, compare source and managed target files in both directions and review operator edits. Retain the transaction backup and verify recovery in a disposable candidate.

For source changes, run `npm run typecheck` and `npm run test:codex`. Keep skips and unavailable integration checks separate from passing results.
