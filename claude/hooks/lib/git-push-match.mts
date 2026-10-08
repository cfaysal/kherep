// Issue #327. Does a shell command force-push? deploy-guard rule 5 asks this.
//
// The old rule ran two regexes over the whole string: one for `git push`, one
// for a force flag. The two matches never had to belong to the same command,
// so `gh api -f x && git push` was blocked and `git -C dir push -f` was not.
//
// shellSegments() cuts the command into simple commands and their words in one
// linear pass. gitInvocations() finds the git subcommand of every `git` word in
// a segment with a reachable-set pass like git-commit-match.mts, so nothing
// backtracks (CodeQL js/redos, #271). forcePushVerdict() checks the arguments
// of each `git push` and scans a word that holds whitespace (an `ssh host "..."`
// or `bash -c '...'` argument) again as shell, down to depth 3. Where the parse
// is unsure it says `uncertain`, and rule 5 falls back to legacyForcePush().
//
// lib/main-checkout.mts (#325) has its own tokenizer; it drops heredoc bodies
// and strips `#` comments, both of which this check must not do, so the two
// stay separate.

export interface ShellSegments {
  segments: string[][];
  // An unterminated quote or heredoc, or unbalanced ( ) or backticks.
  uncertain: boolean;
}

export interface GitInvocation {
  // The subcommand word, backslashes removed, and its index in the segment.
  verb: string;
  at: number;
}

export type ForcePushVerdict = "force" | "none" | "uncertain";
export type SegmentVerdict = "match" | "none" | "uncertain";

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "`"]);
const WHITESPACE = /\s/;
const DELIMITER_END = /[\s;&|()<>]/;

export function shellSegments(command: string): ShellSegments {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let dropNext = false; // the word after a redirection operator is a file or fd
  let uncertain = false;
  let depth = 0;
  let backticks = 0;
  let heredocs: Array<{ word: string; tabs: boolean }> = [];
  const endToken = (): void => {
    if (inToken) {
      if (!dropNext) tokens.push(token);
      dropNext = false;
    }
    token = "";
    inToken = false;
  };
  const endSegment = (): void => {
    endToken();
    dropNext = false;
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  // Heredoc bodies start after the line that opened them. Their lines are
  // split on whitespace only: no quotes, no separators.
  const readBodies = (from: number): number => {
    let at = from;
    for (const { word, tabs } of heredocs) {
      for (;;) {
        if (at >= command.length) {
          uncertain = true;
          heredocs = [];
          return command.length;
        }
        const newline = command.indexOf("\n", at);
        const end = newline < 0 ? command.length : newline;
        let line = command.slice(at, end).replace(/\r$/, "");
        if (tabs) line = line.replace(/^\t+/, "");
        at = end + 1;
        if (line === word) break;
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length) segments.push(words);
      }
    }
    heredocs = [];
    return at;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    const next = command[i + 1];
    const crlf = next === "\r" && command[i + 2] === "\n";
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      inToken = true;
      if (close < 0) { token += command.slice(i + 1); uncertain = true; break; }
      token += command.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      inToken = true;
      let k = i + 1;
      for (; k < command.length && command[k] !== '"'; k++) {
        const c = command[k]!;
        if (c !== "\\" || k + 1 >= command.length) { token += c; continue; }
        const escaped = command[++k]!;
        if (escaped === "\n") continue;
        token += '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
      }
      if (k >= command.length) { uncertain = true; break; }
      i = k + 1;
    } else if (ch === "\\" || (ch === "`" && (next === "\n" || crlf))) {
      // Line continuation (bash `\`, PowerShell backtick). An escaped space
      // stays a space, so the word is scanned again; any other escaped
      // character is kept with its backslash, so a Windows path stays whole.
      if (next === "\n") i += 2;
      else if (crlf) i += 3;
      else if (next === undefined) { token += ch; inToken = true; i++; }
      else { token += WHITESPACE.test(next) ? next : ch + next; inToken = true; i += 2; }
    } else if ((ch === "<" || ch === ">") && next === "(") {
      endSegment(); depth++; i += 2;
    } else if (ch === "<" && next === "<" && command[i + 2] !== "<") {
      endToken();
      i += 2;
      const tabs = command[i] === "-";
      if (tabs) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      let word = "";
      for (; i < command.length && !DELIMITER_END.test(command[i]!); i++) if (!"'\"\\".includes(command[i]!)) word += command[i];
      if (word) heredocs.push({ word, tabs });
      else uncertain = true;
    } else if (ch === "<" || ch === ">") {
      // A redirection, not a separator: `2>&1`, `>out`, `&>all`, `<<< word`.
      if (/^\d+$/.test(token)) { token = ""; inToken = false; } else endToken();
      if (ch === "<" && next === "<") { i += 3; continue; } // here-string: its word is stdin, keep it
      i++;
      if (command[i] === ch || (ch === "<" && command[i] === ">")) i++;
      if (command[i] === "&" || command[i] === "|") i++;
      dropNext = true;
    } else if (ch === "&" && next === ">") {
      i++;
    } else if (ch === "$" && next === "(") {
      endSegment(); depth++; i += 2;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) { uncertain = true; depth = 0; }
      else if (ch === "`") backticks++;
      i++;
      if (ch === "\n" && heredocs.length) i = readBodies(i);
    } else if (WHITESPACE.test(ch)) {
      endToken(); i++;
    } else {
      token += ch; inToken = true; i++;
    }
  }
  endSegment();
  if (depth !== 0 || backticks % 2 !== 0 || heredocs.length) uncertain = true;
  return { segments, uncertain };
}

function bare(word: string): string {
  return word.replace(/\\/g, "");
}

function isGitName(form: string): boolean {
  const name = form.slice(Math.max(form.lastIndexOf("/"), form.lastIndexOf("\\")) + 1).toLowerCase();
  return name === "git" || name === "git.exe";
}

// The raw word keeps a Windows path whole (C:\...\git.exe); the bare one
// reads a bash escape such as g\it.
function isGit(word: string): boolean {
  return isGitName(word) || isGitName(bare(word));
}

// Global options whose value is the next word.
const VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);

// The subcommand of every git word in <segment>. reachable[k]: word k can
// stand where git expects a global option or the subcommand. One pass over
// the segment, however many git words it holds.
export function gitInvocations(segment: string[]): GitInvocation[] {
  const found: GitInvocation[] = [];
  const reachable: boolean[] = new Array(segment.length + 2).fill(false);
  for (let k = 0; k < segment.length; k++) {
    const word = bare(segment[k]!);
    if (reachable[k]) {
      if (VALUE_OPTIONS.has(word)) reachable[k + 2] = true;
      else if (word.startsWith("-")) reachable[k + 1] = true;
      else found.push({ verb: word, at: k });
    }
    if (isGit(segment[k]!)) reachable[k + 1] = true;
  }
  return found;
}

// --force and --force-with-lease with or without a value (an empty one too),
// and an unambiguous abbreviation of --force-with-lease, which git accepts.
// --force-if-includes alone forces nothing.
function isForceFlag(word: string): boolean {
  if (word.startsWith("--")) {
    const name = word.split("=", 1)[0]!;
    return name === "--force" || (name.length >= 9 && "--force-with-lease".startsWith(name));
  }
  return /^-[A-Za-z0-9]+$/.test(word) && word.includes("f");
}

// Does a `git push` in <segment> carry a force flag before `--`, or a
// +refspec anywhere? A refspec after `--` still forces, so `--` ends only the
// flag scan. The flags are collected from the end, so this stays linear.
function forcesInSegment(segment: string[]): boolean {
  const pushes = gitInvocations(segment).filter(({ verb }) => verb === "push");
  if (!pushes.length) return false;
  const flagFrom: boolean[] = new Array(segment.length + 1).fill(false);
  const plusFrom: boolean[] = new Array(segment.length + 1).fill(false);
  for (let k = segment.length - 1; k >= 0; k--) {
    const word = bare(segment[k]!);
    flagFrom[k] = word !== "--" && (isForceFlag(word) || flagFrom[k + 1]!);
    plusFrom[k] = /^\+./.test(word) || plusFrom[k + 1]!;
  }
  return pushes.some(({ at }) => flagFrom[at + 1] || plusFrom[at + 1]);
}

const MAX_DEPTH = 3;

function verdictAt(command: string, matches: (segment: string[]) => boolean, depth: number): SegmentVerdict {
  const parsed = shellSegments(command);
  let verdict: SegmentVerdict = parsed.uncertain ? "uncertain" : "none";
  for (const segment of parsed.segments) {
    if (matches(segment)) return "match";
    for (const word of segment) {
      if (!WHITESPACE.test(word)) continue;
      if (depth >= MAX_DEPTH) { verdict = "uncertain"; continue; }
      const inner = verdictAt(word, matches, depth + 1);
      if (inner === "match") return "match";
      if (inner === "uncertain") verdict = "uncertain";
    }
  }
  return verdict;
}

// The scan above for any check of one simple command (#328 reuses it for
// forge). Never throws: a parser exception is uncertain.
export function segmentVerdict(command: string, matches: (segment: string[]) => boolean): SegmentVerdict {
  try {
    return verdictAt(command, matches, 0);
  } catch {
    return "uncertain";
  }
}

export function forcePushVerdict(command: string): ForcePushVerdict {
  const verdict = segmentVerdict(command, forcesInSegment);
  return verdict === "match" ? "force" : verdict;
}

// The two regexes of rule 5 before #327, unchanged. Rule 5 asks them only when
// forcePushVerdict() is uncertain, so an unparseable command fails closed.
export function legacyForcePush(command: string): boolean {
  if (!/\bgit\s+push\b/.test(command)) return false;
  return /(^|\s)--force(-with-lease)?(=\S+)?(\s|$)/.test(command) || /(^|\s)-f(\s|$)/.test(command);
}
