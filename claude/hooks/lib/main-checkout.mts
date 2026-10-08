// Issue #325. Does a shell command move the HEAD of a repository's main
// checkout? main-checkout-guard asks this before a Bash or PowerShell call.
//
// Sessions share the main checkout. A branch switch there moves every other
// session's working tree under its feet; branch work belongs in a linked
// worktree (`git worktree add <path> -b <branch>`).
//
// checkoutIntents() is the pure part: a token walk like git-commit-match.mts,
// generalised to `git [-C dir] [flags] checkout|switch`, that also follows the
// directory changes of `cd` and `git -C`. judge() then asks git about one
// intent: is the directory in the workspace, is it the main checkout (git-dir
// equals common-dir), and which branch is the default.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { configuredWorkspace, isWithinPath, joinPathLike, normalizePathLike, type EnvLike } from "./workspace-scope.mts";

export interface CheckoutIntent {
  dir: string;
  verb: "checkout" | "switch";
  // A flag that always creates a branch or detaches HEAD.
  flag?: string;
  // Otherwise the first positional: a branch, a SHA, `-`, or for checkout a path.
  ref?: string;
  command: string;
}

export type Judgement = { action: "pass" } | { action: "warn" | "block"; message: string };

// The escape marker. Inline it must sit among the assignments that start a
// segment; the PowerShell spelling is a segment of its own and covers the rest
// of the command. Neither is ever read from the environment.
export const MARKER = "KHEREP_MAIN_CHECKOUT=switch";
const POWERSHELL_MARKER = /^\$env:KHEREP_MAIN_CHECKOUT=switch$/i;

const SEPARATORS = new Set([";", "&", "|", "\n", "\r", "(", ")"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CHANGE_DIR = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "pwsh", "powershell"]);
const SHELL_SCRIPT_FLAG = /^-(?:[A-Za-z]*c|command)$/i;
const GIT_VALUE_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const MOVES: Record<CheckoutIntent["verb"], Set<string>> = {
  checkout: new Set(["-b", "-B", "--orphan", "--detach"]),
  switch: new Set(["-c", "-C", "--create", "--force-create", "--orphan", "--detach", "-d"]),
};
// checkout options that make it a file checkout whatever else is given.
const FILE_MODE = new Set(["--ours", "--theirs", "-p", "--patch", "--pathspec-from-file"]);

// Heredoc and PowerShell here-string bodies are data, not commands: a commit
// message that documents `git switch` must not read as one.
function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | null = null;
  for (const line of command.split("\n")) {
    if (end !== null) {
      // A here-string closes with '@ or "@ at the line start, a heredoc with its word alone.
      if (end.endsWith("@") ? line.startsWith(end) : line.trim() === end) end = null;
      else continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    const hereString = /@(['"])\s*$/.exec(line);
    if (heredoc) end = heredoc[2]!;
    else if (hereString) end = `${hereString[1]}@`;
  }
  return kept.join("\n");
}

// Splits on unquoted separators and whitespace in one pass. Quotes group and
// are dropped; there is no escape processing, so a Windows path keeps its
// backslashes. An unquoted `#` at a word start comments out the line.
function segments(command: string): string[][] {
  const out: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote = "";
  let comment = false;
  const endToken = (): void => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) out.push(tokens);
    tokens = [];
  };
  for (const ch of command) {
    if (comment) {
      if (ch === "\n") { comment = false; endSegment(); }
    } else if (quote) {
      if (ch === quote) quote = "";
      else token += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === "#" && !inToken) {
      comment = true;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token += ch;
      inToken = true;
    }
  }
  endSegment();
  return out;
}

// Git for Windows does not read the /d/... form a Git Bash `cd` produces.
function hostPath(value: string): string {
  const normalized = normalizePathLike(value);
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

// <dir> is already normalized, so only a target with `..` needs the whole path
// normalized again, and a path past any real length limit stops growing: a run
// of `cd x;` stays linear.
function resolveDir(dir: string, value: string): string {
  const target = normalizePathLike(value);
  if (/^(?:[A-Za-z]:\/|\/)/.test(target)) return hostPath(target);
  if (!target) return dir;
  const resolved = target.split("/").includes("..") ? normalizePathLike(joinPathLike(dir, target)) : `${dir}/${target}`;
  return resolved.length > 4096 ? dir : resolved;
}

function commandName(token: string | undefined): string {
  return (token ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
}

function verbIntent(verb: CheckoutIntent["verb"], args: string[], dir: string, command: string): CheckoutIntent | null {
  const dashdash = args.indexOf("--");
  // `checkout -- <paths>` and `checkout <ref> -- <paths>` only restore files.
  if (verb === "checkout" && dashdash >= 0) return null;
  const positionals: string[] = [];
  for (const arg of dashdash >= 0 ? args.slice(0, dashdash) : args) {
    if (arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    // A short cluster such as -qb is -q -b.
    const names = /^-[A-Za-z]{2,}$/.test(arg) ? [...arg.slice(1)].map((letter) => `-${letter}`) : [arg.split("=")[0]!];
    const flag = names.find((name) => MOVES[verb].has(name));
    if (flag) return { dir, verb, flag, command };
    if (verb === "checkout" && names.some((name) => FILE_MODE.has(name))) return null;
  }
  // `checkout <tree-ish> <pathspec>...` restores files as well.
  if (!positionals.length || (verb === "checkout" && positionals.length > 1)) return null;
  return { dir, verb, ref: positionals[0], command };
}

function gitIntent(args: string[], dir: string, command: string): CheckoutIntent | null {
  let k = 0;
  for (; k < args.length && args[k]!.startsWith("-"); k++) {
    if (args[k] === "-C" && args[k + 1] !== undefined) dir = resolveDir(dir, args[++k]!);
    else if (GIT_VALUE_OPTIONS.has(args[k]!)) k++;
  }
  const verb = args[k];
  return verb === "checkout" || verb === "switch" ? verbIntent(verb, args.slice(k + 1), dir, command) : null;
}

// Every segment of <command> that would move HEAD, with the directory it runs
// in. Segments carrying the escape marker are left out.
export function checkoutIntents(command: string, cwd: string, escapedFromStart = false): CheckoutIntent[] {
  const found: CheckoutIntent[] = [];
  let dir = hostPath(cwd);
  let escapedFromHere = escapedFromStart;
  for (const tokens of segments(withoutHeredocs(command))) {
    if (POWERSHELL_MARKER.test(tokens.join(""))) {
      escapedFromHere = true;
      continue;
    }
    let i = 0;
    let escaped = escapedFromHere;
    for (; i < tokens.length && ASSIGNMENT.test(tokens[i]!); i++) if (tokens[i] === MARKER) escaped = true;
    const name = commandName(tokens[i]);
    const args = tokens.slice(i + 1);
    if (CHANGE_DIR.has(name)) {
      const target = args.find((arg) => !arg.startsWith("-"));
      if (target) dir = resolveDir(dir, target);
    } else if (SHELLS.has(name)) {
      const flag = args.findIndex((arg) => SHELL_SCRIPT_FLAG.test(arg));
      if (flag >= 0 && args[flag + 1] !== undefined) found.push(...checkoutIntents(args[flag + 1]!, dir, escaped));
    } else if (name === "git" && !escaped) {
      const intent = gitIntent(args, dir, tokens.slice(i).join(" "));
      if (intent) found.push(intent);
    }
  }
  return found;
}

function git(dir: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

// origin/HEAD, else a local main or master. init.defaultBranch alone says
// nothing about this repository, so it is never consulted.
export function defaultBranch(dir: string): string | null {
  const head = git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head?.startsWith("refs/remotes/origin/")) return head.slice("refs/remotes/origin/".length);
  return ["main", "master"].find((name) => git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) !== null)
    ?? null;
}

function isMainCheckout(dir: string): boolean {
  const dirs = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split(/\r?\n/);
  if (!dirs || dirs.length !== 2) return false;
  const [gitDir, commonDir] = dirs.map((value) => normalizePathLike(value).toLowerCase());
  return gitDir === commonDir;
}

// True when the intent leaves the checkout on <main>: it names main, HEAD, a
// previous branch that is main, or (checkout only) a path rather than a ref.
function staysOnDefault(intent: CheckoutIntent, main: string): boolean {
  const ref = intent.ref!;
  if (ref === main || ref === `refs/heads/${main}` || ref === "HEAD" || ref === "@") return true;
  if (ref === "-") return git(intent.dir, ["rev-parse", "--symbolic-full-name", "@{-1}"]) === `refs/heads/${main}`;
  return intent.verb === "checkout"
    && git(intent.dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]) === null
    && fs.existsSync(resolveDir(intent.dir, ref));
}

export function judge(intent: CheckoutIntent, env: EnvLike = process.env): Judgement {
  if (!isWithinPath(intent.dir, hostPath(configuredWorkspace(env))) || !isMainCheckout(intent.dir)) return { action: "pass" };
  const main = defaultBranch(intent.dir);
  if (!main) {
    return { action: "warn", message: `main-checkout-guard could not determine the default branch of ${intent.dir} `
      + `(no origin/HEAD, main or master); \`${intent.command}\` was not checked.` };
  }
  if (!intent.flag && staysOnDefault(intent, main)) return { action: "pass" };
  return { action: "block", message: `\`${intent.command}\` would move the main checkout ${intent.dir} off its default branch ${main}` };
}
