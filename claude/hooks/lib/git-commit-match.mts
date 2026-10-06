// Does a shell command run `git ... commit`? commit-guard asks this before it
// checks anything else (issue #271).
//
// It accepts exactly the strings that
//   /\bgit\b(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit\b/
// accepts, in linear time. That regex backtracks exponentially (CodeQL
// js/redos): a `-C` token reads as a flag or as a flag with a value, and
// `--long` reads as `--` + `long` or `-` + `-long`, so a run of such tokens
// without a following `commit` costs about 4x per token.
//
// The regex only ever consumes whole whitespace-separated tokens: every
// element is followed by `\s+`. So the command is split into tokens once, and
// one pass tracks which tokens the regex can reach:
// - the token after one ending in `git` with a non-word character (or
//   nothing) before it is reachable (`\bgit\b\s+`);
// - after a reachable FLAG token (`-[\w-]+`, optionally `=` and a value) the
//   next token is reachable;
// - after a reachable `-c` or `-C` token the token after next is reachable
//   too (the pair `-c <value>`);
// - a reachable token that starts with `commit` not followed by a word
//   character is a match (`commit\b`).
// Every `git` the regex can start from ends a token, so all starts share the
// one pass.

const TOKEN = /\S+/g;
const FLAG = /^-[\w-]+(?:=\S+)?$/;
const COMMIT = /^commit\b/;
const GIT_END = /\bgit$/;

export function commitsViaGit(command: string): boolean {
  const tokens = command.match(TOKEN) || [];
  // reachable[k]: the regex can stand right before token k.
  const reachable: boolean[] = new Array(tokens.length + 2).fill(false);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (reachable[k]) {
      if (COMMIT.test(token)) return true;
      if (FLAG.test(token)) reachable[k + 1] = true;
      if (token === "-c" || token === "-C") reachable[k + 2] = true;
    }
    if (GIT_END.test(token)) reachable[k + 1] = true;
  }
  return false;
}
