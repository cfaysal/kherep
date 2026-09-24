# Installation

Kherep installs rules, hooks, skills and runtime adapters into your existing coding-agent setup. Use Node.js 24, npm, Git and a working Claude Code or Codex installation. The Claude installer needs Bash; on Windows use Git Bash.

Choose the workspace in which Kherep should apply. The source checkout can be anywhere; the workspace is the set of repositories your agents work on.

## 1. Get the source

```sh
git clone https://github.com/cfaysal/kherep.git
cd kherep
npm ci
```

Use absolute paths. For the Bash installer on Windows, use Git Bash paths such as `/c/Projects`, including for environment-variable overrides. On macOS, use native absolute POSIX paths. The Node-based Codex installer accepts native paths separately.

## 2. Review an isolated installation

This preview writes managed files to a new candidate directory, leaves workspace Git configuration unchanged and does not install dependencies or start a memory agent. It also skips the Atlassian credential and Confluence knowledge-space steps, so it never reads a real credential file named by an inherited `KHEREP_ATL_CRED_FILE_*` variable and makes no live call.

```sh
candidate_root="$(mktemp -d)"
mkdir -p "$candidate_root/claude" "$candidate_root/workspace"

CLAUDE_HOME="$candidate_root/claude" \
KHEREP_WORKSPACE="$candidate_root/workspace" \
KHEREP_CREDENTIALS_ROOT="$candidate_root/integration-config" \
KHEREP_INSTALL_SKIP_GITCONFIG=1 \
KHEREP_INSTALL_SKIP_RUNTIME_AGENT=1 \
KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
SKIP_SECRETS=1 SKIP_DEPS=1 bash bootstrap/install.sh
```

Inspect the candidate's rules, settings, hook commands and installation receipt. Keep its backup until you have checked recovery. A files-only preview does not establish that connected services work.

## 3. Install the Claude adapter

From the checkout, select your actual workspace:

```sh
KHEREP_WORKSPACE="$HOME/projects" \
KHEREP_INSTALL_SKIP_RUNTIME_AGENT=1 \
bash bootstrap/install.sh
```

Replace the workspace with your chosen absolute path. The normal dependency phase installs the declared npm tools and Claude plugins. Encrypted secrets are skipped by default. The memory-agent switch leaves an existing agent untouched and avoids starting an unconfigured one.

The installer places managed rules, hooks, skills, agents and routing. It uses backups and updates its managed configuration. Workspace Git-hook binding is part of normal installation; review the chosen workspace before applying it.

For a files-only installation, set `SKIP_DEPS=1`. Install and configure the required external tools separately before relying on their integrations.

## 4. Set up Codex

After setting up the shared dependencies, follow [Codex integration](CODEX.md). It has a separate installer and configuration home. Select the MCP registry appropriate to your setup.

## 5. Configure integrations

Connection profiles ship unconfigured. Kherep does not provision a Confluence space, local model or remote MCP service. Use your own backend and account bindings.

| Setting | Purpose |
| --- | --- |
| `KHEREP_WORKSPACE` | Workspace where orchestration applies |
| `KHEREP_PROFILE` | Explicit `win` or `mac` host profile |
| `KHEREP_CREDENTIALS_ROOT` | External integration-configuration root |
| `KHEREP_LOCAL_CONFIG` | Local-inference configuration |
| `KHEREP_INSTALL_SKIP_GITCONFIG` | Skip Git configuration during a preview |
| `KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE` | Skip resolving the Confluence knowledge space (throwaway installs such as the smoke test); only `1` skips |
| `KHEREP_INSTALL_SKIP_ATL_CREDENTIAL` | Skip reading and live-verifying the Atlassian service-account credential (throwaway installs such as the smoke test); only `1` skips |
| `KHEREP_INSTALL_SKIP_RUNTIME_AGENT` | Leave the memory runtime agent untouched |
| `KHEREP_INSTALL_ATLASSIAN_TOOLS` | Opt into Jira/MPAC helpers. The two Confluence brokers and the modules they import are installed without it, because the observation agent needs them |
| `KHEREP_EXISTING_USER_SETTINGS` | Read-only settings fixture for candidate review |
| `KHEREP_EXISTING_PROJECT_SETTINGS` | Read-only project-settings fixture |
| `KHEREP_WORK_ITEM_REQUIRED` | `1` enforces work-item keys under `KHEREP_WORKSPACE`, `0` turns it off. Persisted into the commit policy file; without it an upgrade keeps the installed value, a fresh install uses `0` |
| `KHEREP_WORK_ITEM_PATTERN` | Extended regex for the accepted key. Persisted into the commit policy file; without it an upgrade keeps the installed pattern |

The Central Brain is the knowledge space the installer resolves for this host; the observation agents write to it through the [Atlassian brokers](../modules/atl-jira-brokers/README.md), which also cover Jira operations. Keep private configuration outside Git.

The optional encrypted-secrets phase requires an external bundle and key. Enable `SKIP_SECRETS=0` only after configuring and reviewing the destination.

## Model and work-item policy

Claude dispatch defaults to the aliases `opus`, `sonnet`, `haiku` and `fable`, with role-specific pins. Set `KHEREP_ALLOWED_MODELS` to a non-empty comma-separated replacement list. Set `KHEREP_AGENT_MODEL_POLICY` to a non-empty JSON object to override individual role pins.

Every resulting role pin must occur in the allowed-model list. Empty, malformed or inconsistent policy blocks dispatch. A narrower model list therefore needs corresponding role overrides.

Set `KHEREP_WORK_ITEM_REQUIRED=1` during installation to require work-item keys for repositories under `KHEREP_WORKSPACE`. `KHEREP_WORK_ITEM_PATTERN` configures the accepted subject pattern. The installer writes the workspace and both values to `kherep/githooks/commit-policy` next to the Git `commit-msg` hook, so the rule binds every commit on the host, whether it comes from a terminal, an IDE, Codex or Claude, without the variables being set there. The file is LF-only `key=value` text, backed up like every managed file and checked by `drift-check.sh`. At commit time a non-empty `KHEREP_WORKSPACE`, `KHEREP_WORK_ITEM_REQUIRED` or `KHEREP_WORK_ITEM_PATTERN` still overrides the file, and `KHEREP_WORK_ITEM=none` still skips the key check for one commit. A malformed file is ignored with a warning instead of blocking commits. The product does not require a particular tracker or space key.

## Verify the installed runtime

Start the selected runtime normally in the configured workspace. Confirm:

1. Kherep rules and routing are discovered.
2. A harmless tool call completes.
3. Managed hook commands execute.
4. Each integration you need is discovered and answers a harmless request.
5. A synthetic private-input fixture follows the configured privacy route.

Read the installed source receipt and target files when comparing an upgrade. Report unavailable integrations separately from working ones.

## Upgrades and rollback

Compare managed source and installed files in both directions before replacing an existing setup. Preserve operator edits and inspect an isolated candidate with read-only settings fixtures.

The installer records backups through managed transactions. Verify recovery in a disposable candidate and retain the recorded backup. Never recursively remove a configuration home to repair an installation.

The workspace rule files `CLAUDE.md` and `AGENTS.md` keep the operator's content. Kherep manages only the block between `<!-- kherep-project-rules:start -->` and `<!-- kherep-project-rules:end -->`. The block is a short reference: the Kherep rules themselves are installed at user level, in `~/.claude/CLAUDE.md` for Claude and in the Codex home `AGENTS.md` for Codex, and both runtimes load those files in every session. On the first upgrade the block is appended after the existing text, which stays byte for byte as it was. A file that still equals a template from an earlier Kherep version is replaced by the block, and a file with only one of the two markers is refused before anything changes. Drift checking compares only the block.

Existing memory services can have persisted identities and state outside the managed files. Preserve recovery copies and verify the selected backend before retiring an existing integration.

A host that was enrolled in the retired Central Brain server backend loses that wiring on upgrade. The Claude installer removes the hook commands it added to `settings.json` and parks `kherep/central-brain/selection.json` in a `_deprecated/` sibling; both previous versions stay in the installation backup. The Codex installer does the same for its managed configuration block, see [Codex integration](CODEX.md#retired-memory-backend). Data held by that server is not touched.
