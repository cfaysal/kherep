import path from "node:path";

// Issue #72. A Codex execpolicy rule that lets registered runtimes use the
// Control Plane messaging CLI without an approval per message. Codex reads
// `.rules` files from `rules/` next to an active config layer at startup, and
// `allow` means "Run the command outside the sandbox without prompting"
// (developers.openai.com/codex/rules). The file is fully managed by Kherep: it
// is rewritten on every install, and no other rule file is touched.
//
// Issue #436. One rule per command: the stable launcher of the config root
// first, then the CLI of the installing checkout, which the daemon's task
// prompt and the delivery hook still name until they switch to the launcher.

export const CONTROL_PLANE_RULES_FILE = "kherep-control-plane.rules";

// Only the messaging subcommands. `task`, `node` and every other command of the
// CLI keep asking.
export const MSG_SUBCOMMANDS = Object.freeze(["send", "sessions", "inbox", "status"] as const);

export function controlPlaneCli(repoRoot: string): string {
  return path.join(repoRoot, "modules", "control-plane", "node", "cli.mts");
}

export function controlPlaneRulesPath(codexHome: string): string {
  return path.join(codexHome, "rules", CONTROL_PLANE_RULES_FILE);
}

// A Starlark string literal. Control characters have no place in a path or a
// command token, so they are refused rather than escaped.
export function starlarkString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Control characters are not allowed in a Codex rule string");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Codex shell-splits the match/not_match examples, so a Windows path with
// backslashes has to be single-quoted there or the rule file fails to load.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function list(items: string[]): string {
  return `[\n${items.map((item) => `        ${starlarkString(item)},`).join("\n")}\n    ]`;
}

// `node` and `cli` are the first two tokens as Codex splits the command a
// runtime runs; `prefix` is that command as the match examples spell it.
export interface RuleCommand { node: string; cli: string; prefix: string }

// The launcher rule takes launcherCommand() verbatim, so its examples are the
// exact command the instructions name. That command double-quotes a path with
// no double quote, backslash, `$` or backtick, which a shell split undoes.
export function launcherRule(command: string): RuleCommand {
  const match = /^node "([^"\\$`]+)"$/.exec(command);
  if (!match) throw new Error('the launcher command must be node "<path>"');
  return { node: "node", cli: match[1], prefix: command };
}

// `node` is the executable as Codex tokenises the command a runtime runs.
export function cliRule(cli: string, node = "node"): RuleCommand {
  return { node, cli, prefix: `${shellQuote(node)} ${shellQuote(cli)}` };
}

function prefixRule({ node, cli, prefix }: RuleCommand): string[] {
  const example = (...rest: string[]): string => [prefix, ...rest].join(" ");
  const alternatives = `[${MSG_SUBCOMMANDS.map(starlarkString).join(", ")}]`;
  return [
    "prefix_rule(",
    `    pattern = [${starlarkString(node)}, ${starlarkString(cli)}, "msg", ${alternatives}],`,
    '    decision = "allow",',
    `    justification = ${starlarkString("Kherep Control Plane messaging: msg send, sessions, inbox and status only")},`,
    `    match = ${list([
      example("msg", "sessions"),
      example("msg", "send", "peer/session", "--", "hello"),
      example("msg", "inbox", "--all"),
      example("msg", "status", "message-1"),
    ])},`,
    `    not_match = ${list([
      example("task", "new", "--title", "x"),
      example("node", "unenroll"),
      example("msg"),
    ])},`,
    ")",
  ];
}

export function renderControlPlaneRules(commands: readonly RuleCommand[]): string {
  if (commands.length === 0) throw new Error("the Control Plane rules need at least one command");
  return [
    "# Managed by Kherep (codex/install.mts). Rewritten on every install; put your own rules in another file.",
    "# Lets registered runtimes use the Control Plane messaging CLI without an approval per message.",
    ...commands.flatMap(prefixRule),
    "",
  ].join("\n");
}
