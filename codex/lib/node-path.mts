import fs from "node:fs";
import path from "node:path";

// Issue #55. Hook commands name the Node executable by absolute path. On
// Homebrew, process.execPath is the versioned keg, which `brew upgrade node`
// deletes, so a block written before the upgrade names a path no current
// render produces.

const HOMEBREW_KEG = /^(.*)[\\/]Cellar[\\/]node[\\/][^\\/]+[\\/]bin[\\/]node$/;

function realpath(target: string): string | undefined {
  try { return fs.realpathSync(target); } catch { return undefined; }
}

// <prefix>/bin/node when the executable is the Homebrew keg that link points
// to; the link survives an upgrade, the keg does not. Otherwise the path itself.
export function stableNodePath(execPath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(execPath);
  if (platform === "win32") return resolved;
  const actual = realpath(resolved);
  if (!actual) return resolved;
  for (const candidate of new Set([resolved, actual])) {
    const keg = candidate.match(HOMEBREW_KEG);
    if (!keg) continue;
    const linked = path.join(keg[1], "bin", "node");
    if (realpath(linked) === actual) return linked;
  }
  return resolved;
}

function isNodeExecutable(value: string): boolean {
  if (/["'\0\r\n]/.test(value)) return false;
  if (value.startsWith("/")) return path.posix.basename(value) === "node";
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) && /^node\.exe$/i.test(path.win32.basename(value));
}

function unescapeJson(value: string): string | undefined {
  try { return JSON.parse(`"${value}"`) as string; } catch { return undefined; }
}

// Distinct Node executables the managed block's command strings name, other
// than the current one. Only these paths are ever substituted into fragments.
export function managedNodePaths(config: string, startMarker: string, endMarker: string, current: string): string[] {
  const start = config.indexOf(startMarker);
  if (start < 0) return [];
  const end = config.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return [];
  const found = new Set<string>();
  for (const [literal] of config.slice(start + startMarker.length, end).matchAll(/"(?:\\.|[^"\\\r\n])*"/g)) {
    const value = unescapeJson(literal.slice(1, -1));
    if (value === undefined) continue;
    const tokens = [value, ...[...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2])];
    for (const token of tokens) {
      for (const candidate of [token, unescapeJson(token)]) {
        if (candidate !== undefined && candidate !== current && isNodeExecutable(candidate)) found.add(candidate);
      }
    }
  }
  return [...found];
}

// The forms a path takes in a rendered fragment: escaped once as a TOML basic
// string, and twice where the value is itself a JSON string.
function renderedForms(value: string): string[] {
  const once = JSON.stringify(value).slice(1, -1);
  return [once, JSON.stringify(once).slice(1, -1)];
}

// The fragment as it was rendered with `to` as the Node executable. Only whole
// quoted occurrences of `from` are replaced; nothing else in the text changes.
export function withNodePath(fragment: string, from: string, to: string): string {
  const [fromOnce, fromTwice] = renderedForms(from);
  const [toOnce, toTwice] = renderedForms(to);
  const pairs = new Map([[fromOnce, toOnce]]);
  if (fromTwice !== fromOnce) pairs.set(fromTwice, toTwice);
  // The longer, twice-escaped form first, so it is never matched as the shorter.
  const alternatives = [...pairs.keys()].sort((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return fragment.replace(new RegExp(`(?<=["'])(?:${alternatives.join("|")})(?=["'\\\\])`, "g"),
    (form) => pairs.get(form)!);
}

// The known fragments plus each one rendered with a Node path the live block
// names. Matching stays exact; only the executable path may differ.
export function withManagedNodePaths(fragments: string[], current: string, previous: string[]): string[] {
  if (previous.length === 0) return fragments;
  const variants = previous.flatMap((node) => fragments.map((fragment) => withNodePath(fragment, current, node)));
  return [...new Set([...fragments, ...variants])];
}
