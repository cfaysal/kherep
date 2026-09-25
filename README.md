![Kherep: Maestro Agent Orchestration; Claude, Codex & More; Rules, Hooks & Skills; MCP Integration; Model & Tool Routing; Local Inference; Central Brain knowledge base in Confluence; ...](assets/branding/kherep-banner.png)

# Kherep

Kherep coordinates coding agents, tools and shared knowledge across Claude Code and Codex. You direct the work; a Maestro plans the task, assigns bounded work and checks the result against code, tests and the requested outcome.

Use Kherep to give your agents consistent working rules, reusable skills and a shared approach to choosing models and tools. Runtime adapters keep Claude and Codex configuration separate while applying the same orchestration principles.

## Features

- **Maestro agent orchestration:** plan work, delegate focused tasks and verify the combined result.
- **Claude Code and Codex adapters:** shared rules with installation and hooks for each runtime.
- **Rules, hooks and skills:** reusable workflows for implementation, review, debugging and delivery.
- **Model and tool routing:** choose available capabilities through operator-configured policies.
- **MCP integration:** connect explicitly configured services through transport and authentication adapters.
- **Local inference:** use configured local processing routes, including a separate path for private inputs.
- **Central Brain:** a shared knowledge base in a dedicated Confluence space. The Claude and Codex observation agents file durable findings from completed turns as pages through the service-account brokers.
- **Turn-completion observations:** after a substantial Claude turn a Stop hook has the Maestro dispatch `claude-obs`, and Codex can dispatch one bounded `codex-obs` pass; see [Codex integration](docs/CODEX.md#turn-completion-observations).

Backends and integrations are configured separately. Installing an adapter does not provision a model, MCP service or Confluence space.

## Get started

Use Node.js 24, npm and Git. The Claude installer also needs Bash; on Windows use Git Bash.

```sh
git clone https://github.com/cfaysal/kherep.git
cd kherep
npm ci
```

Follow the [installation guide](docs/INSTALLATION.md) to select your workspace, review an isolated installation and set up the required runtime. For the Central Brain space and the brokers that write to it, see [Atlassian brokers](modules/atl-jira-brokers/README.md).

Runtime adapters target Windows and macOS. See each component's documentation for its requirements.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Installation](docs/INSTALLATION.md) | Claude setup, isolated preview, upgrades and rollback |
| [Codex integration](docs/CODEX.md) | Codex installer options and runtime verification |
| [Atlassian brokers](modules/atl-jira-brokers/README.md) | Jira and Confluence service-account operations, including the Central Brain space |
| [Control Plane](modules/control-plane/README.md) | Cloudflare Worker and node daemon for node enrollment, liveness and read-only commands (Phase 1) |
| [Contributing](CONTRIBUTING.md) | Source setup and test commands |
| [Agent instructions](AGENTS.md) | Reading order and repository working rules |

## Repository layout

| Directory | Contents |
| --- | --- |
| `claude/` | Claude rules, hooks, skills, agents and routing |
| `codex/` | Codex adapters, plugin projection, installers and parity checks |
| `bootstrap/` | Host profiles, managed installation, backups and drift checks |
| `modules/local-inference/` | Local processing runner and configuration |
| `modules/mcp-auth-bridge/` | Authenticated MCP transport adapters |
| `modules/atl-jira-brokers/` | Operator-configured Jira and Confluence service-account operations |
| `modules/twg/` | Bounded Teamwork Graph reads |
| `modules/control-plane/` | Control Plane Worker, node daemon and their shared protocol |

Keep personal configuration and credentials outside the checkout. See the component guides for configuration, permissions and supported integrations.

## License

Kherep is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). Bundled and adapted third-party material keeps its own license, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Claude, Claude Code, Codex, Atlassian, Jira, Confluence and other product names are trademarks of their respective owners; Kherep is an independent project and is not affiliated with or endorsed by Anthropic, OpenAI or Atlassian.
