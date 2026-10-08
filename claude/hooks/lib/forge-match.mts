// Issue #328. Does a shell command deploy a Forge app to production, or
// install it on a named site? deploy-guard rules 1 and 2 ask this.
//
// The old rules ran regexes over the whole string. `forge deploy` and
// `-e production` never had to belong to the same command, so
// `forge deploy -e development && grep -e production log` was blocked, and
// `forge deploy -e "production"` or `forge.cmd deploy -e production` was not.
//
// segmentVerdict() from git-push-match.mts cuts the command into simple
// commands and scans quoted words again as shell (#327). This module reads
// the arguments of each forge invocation in a segment. Where the parse is
// unsure the verdict is `uncertain`, and the rules fall back to
// legacyForgeDeploy() and legacyForgeInstall(), so they fail closed.

import { segmentVerdict, type GitInvocation, type SegmentVerdict } from "./git-push-match.mts";

function bare(word: string): string {
  return word.replace(/\\/g, "");
}

function isForgeName(form: string): boolean {
  return /^@forge\/cli(?:@\S*)?$/i.test(form) || /(?:^|[\\/])forge(?:\.exe|\.cmd)?$/i.test(form);
}

// The raw word keeps a Windows path whole; the bare one reads a bash escape.
function isForge(word: string): boolean {
  return isForgeName(word) || isForgeName(bare(word));
}

// The verb of every forge word in <segment>: the next word that is not a flag.
export function forgeInvocations(segment: string[]): GitInvocation[] {
  const found: GitInvocation[] = [];
  let pending = false;
  for (let k = 0; k < segment.length; k++) {
    const word = bare(segment[k]!);
    if (pending && !word.startsWith("-")) {
      found.push({ verb: word, at: k });
      pending = false;
    }
    if (isForge(segment[k]!)) pending = true;
  }
  return found;
}

// The value of a <long> or <short> option at word k: `--long X`, `--long=X`,
// `-s X`, `-s=X` and `-sX`. Undefined when word k is not that option.
function optionValue(segment: string[], k: number, long: string, short: string): string | undefined {
  const word = bare(segment[k]!);
  if (word === long || word === short) return k + 1 < segment.length ? bare(segment[k + 1]!) : undefined;
  if (word.startsWith(`${long}=`)) return word.slice(long.length + 1);
  if (word.startsWith(short) && !word.startsWith("--")) return word.slice(short.length).replace(/^=/, "");
  return undefined;
}

// Operator decision 1: the `production*` prefix as before, and `prod`.
function isProduction(value: string): boolean {
  const name = value.toLowerCase();
  return name.startsWith("production") || name === "prod";
}

// Every word after the first deploy is also after any later one, so checking
// from the first deploy alone is enough and keeps the scan linear.
function deploysProduction(segment: string[]): boolean {
  const deploy = forgeInvocations(segment).find(({ verb }) => verb === "deploy");
  if (!deploy) return false;
  for (let k = deploy.at + 1; k < segment.length; k++) {
    const value = optionValue(segment, k, "--environment", "-e");
    if (value !== undefined && isProduction(value)) return true;
  }
  return false;
}

// The site of a `forge install` in <segment>, read the same way. Operator
// decision 4: `forge install list` is read-only.
function installSite(segment: string[]): string | undefined {
  const install = forgeInvocations(segment).find(({ verb, at }) => verb === "install" && bare(segment[at + 1] ?? "") !== "list");
  if (!install) return undefined;
  for (let k = install.at + 1; k < segment.length; k++) {
    const site = optionValue(segment, k, "--site", "-s");
    if (site !== undefined) return site;
  }
  return undefined;
}

export function forgeDeployVerdict(command: string): SegmentVerdict {
  return segmentVerdict(command, deploysProduction);
}

export function forgeInstallVerdict(command: string): { verdict: SegmentVerdict; site: string } {
  let site = "";
  const verdict = segmentVerdict(command, (segment) => {
    const found = installSite(segment);
    if (found !== undefined) site = found;
    return found !== undefined;
  });
  return { verdict, site };
}

// The regexes of rules 1 and 2 before #328, unchanged. The rules ask them only
// when the verdict is uncertain, so an unparseable command fails closed.
export function legacyForgeDeploy(command: string): boolean {
  return /\bforge\s+deploy\b/.test(command) && /(--environment|-e)[=\s]+production/.test(command);
}

export function legacyForgeInstall(command: string): string | null {
  if (!/\bforge\s+install\b/.test(command)) return null;
  const siteMatch = command.match(/(?:^|\s)(?:--site|-s)[=\s]+([^\s"']+)/);
  return siteMatch ? siteMatch[1]! : null;
}
