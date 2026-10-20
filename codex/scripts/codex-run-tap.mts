// TAP reader and skip-list helpers for the Codex run guard (issue #550). Pure, no I/O.
//
// Reads the TAP that `node --test --test-reporter=tap` writes, as measured on
// Node 22.18 (CI) and 26.10 (local): one `ok|not ok N - <name>[ # SKIP|TODO
// [<reason>]]` line per test, nested subtests indented by four spaces, a YAML
// block after each record that names its `type`, and a final summary block.
// Anything else throws, so a format change on a new Node is loud, never read
// as "no skips":
// - The summary is the last block of the file: a top-level `1..N`, then
//   `tests, suites, pass, fail, cancelled, skipped, todo, duration_ms` in that
//   order. Test output is echoed into the TAP as `# ...` comments, so an
//   earlier `# tests N` line proves nothing.
// - A record whose YAML block has no `type:` line is malformed.
// Node escapes `\` and `#` in names and reasons; one pass undoes both.

export interface TapRecord {
  name: string;
  depth: number;
  ok: boolean;
  directive: "SKIP" | "TODO" | null;
  reason: string | null;
  type: string;
}
export interface TapSummary {
  tests: number; suites: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number;
}
export interface ParsedTap { summary: TapSummary; records: TapRecord[] }
export interface SkipEntry { name: string; reason: string | null }

const SUMMARY_KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"] as const;
const RECORD = /^((?: {4})*)(ok|not ok) \d+(?: - (.*))?$/;
const DIRECTIVE = /^(.*?) # (SKIP|TODO)(?: (.*))?$/;

function malformed(detail: string): Error {
  return new Error(`malformed TAP: ${detail}`);
}

export function unescapeTap(text: string): string {
  return text.replace(/\\([\\#])/g, "$1");
}

function readSummary(lines: string[]): TapSummary {
  const block = lines.slice(-(SUMMARY_KEYS.length + 2));
  const plan = /^1\.\.\d+$/.test(block[0] ?? "");
  const duration = /^# duration_ms \d+(?:\.\d+)?$/.test(block[block.length - 1] ?? "");
  if (block.length !== SUMMARY_KEYS.length + 2 || !plan || !duration) throw malformed("no summary block at end of file");
  const summary = {} as TapSummary;
  SUMMARY_KEYS.forEach((key, index) => {
    const match = new RegExp(`^# ${key} (\\d+)$`).exec(block[index + 1]);
    if (!match) throw malformed("no summary block at end of file");
    summary[key] = Number(match[1]);
  });
  return summary;
}

// The YAML block that must directly follow the record at `index`: its `type:`
// and the index of its closing `...` line, or null when either is absent.
function yamlBlock(lines: string[], index: number, indent: string): { type: string; end: number } | null {
  if (lines[index + 1] !== `${indent}  ---`) return null;
  let type: string | null = null;
  for (let line = index + 2; line < lines.length; line++) {
    if (lines[line] === `${indent}  ...`) return type === null ? null : { type, end: line };
    const match = new RegExp(`^${indent}  type: '([a-z]+)'$`).exec(lines[line]);
    if (match) type = match[1];
  }
  return null;
}

export function parseTap(text: string): ParsedTap {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const summary = readSummary(lines);
  const body = lines.slice(0, -(SUMMARY_KEYS.length + 2));
  const records: TapRecord[] = [];
  for (let index = 0; index < body.length; index++) {
    const match = RECORD.exec(body[index]);
    if (!match) continue;
    const [, indent, status, rest = ""] = match;
    const directive = DIRECTIVE.exec(rest);
    const name = unescapeTap(directive ? directive[1] : rest);
    const yaml = yamlBlock(body, index, indent);
    if (yaml === null) throw malformed(`record without type: ${name}`);
    records.push({
      name,
      depth: indent.length / 4,
      ok: status === "ok",
      directive: directive ? (directive[2] as "SKIP" | "TODO") : null,
      reason: directive && directive[3] !== undefined ? unescapeTap(directive[3]) : null,
      type: yaml.type,
    });
    index = yaml.end; // a YAML block (an error message, a stack) never yields a record
  }
  return { summary, records };
}

// The skipped tests in TAP order, in the entry shape of codex-run-expected.json.
// Suite records are left out: the guard refuses a skipped suite on its own.
export function observedSkips(parsed: ParsedTap): SkipEntry[] {
  return parsed.records
    .filter((record) => record.directive === "SKIP" && record.type === "test")
    .map((record) => ({ name: record.name, reason: record.reason }));
}

// The one serialiser for skip lists: `print` and the observed block of `check`.
export function formatSkips(entries: SkipEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

// Multiset difference by (name, reason): what `a` has beyond `b`.
function minus(a: SkipEntry[], b: SkipEntry[]): SkipEntry[] {
  const key = (entry: SkipEntry) => JSON.stringify([entry.name, entry.reason]);
  const rest = b.map(key);
  return a.filter((entry) => {
    const at = rest.indexOf(key(entry));
    if (at >= 0) rest.splice(at, 1);
    return at < 0;
  });
}

export function compareSkips(expected: SkipEntry[], observed: SkipEntry[]): { missing: SkipEntry[]; extra: SkipEntry[] } {
  return { missing: minus(expected, observed), extra: minus(observed, expected) };
}
