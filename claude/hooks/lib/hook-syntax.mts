#!/usr/bin/env node
/**
 * hook-syntax.mts  -  does Node's own parser accept a hook file, without running it
 *
 * `node --check` cannot answer that for a .mts file (issue #278). It never
 * type-strips: it compiles the raw source as CommonJS with module detection, so
 * any file with `import` or `export` exits 0 whatever follows (`export const
 * x = ;` passed as healthy), and a file without them is rejected for valid type
 * annotations. Measured on Node 26.10.0; the same code is in 22.18.0 and 24.1.0.
 *
 * For .mts this runs the two parsers Node runs at load time, in-process:
 * `module.stripTypeScriptTypes` (the error a hook raises at start), then a V8
 * module parse of the stripped source through a `data:` import. One appended
 * import of an unknown scheme makes the link fail after the parse and before
 * anything is instantiated, so top-level code never runs. ~1 ms per file.
 * .mjs takes the second step only. .js and .cjs keep the path the integrity hook
 * had before: an in-process vm.Script parse, confirmed by `node --check` when it
 * rejects, which is correct for CommonJS. That child runs without NODE_OPTIONS,
 * the policy the .mts path has: only Node's default loader is trusted (#292).
 *
 * Three states, never merged (goldene Regel 12): OK, DEFEKT (Node's parser
 * rejected it), UNGEPRUEFT (neither proven). A Node without the stripper, or an
 * error this file does not know, is UNGEPRUEFT and never OK.
 * Known limit: link-time SyntaxErrors (`import { nope } from "node:fs"`) are not
 * detected; the probe's failed resolution comes first. `node --check` never
 * caught them either.
 * A module customization hook (`--import`/`--require` with `module.register` or
 * `module.registerHooks`) that resolves the probe specifier is stopped by the
 * probe's import attribute before anything is instantiated, for every format
 * whose attributes Node validates: UNGEPRUEFT, never OK. A hook that also
 * rewrites the import attributes, short-circuits `load`, or returns a format
 * whose attributes Node does not validate (`module-typescript`,
 * `commonjs-typescript`) can still let the checked file run; the verdict then
 * stays UNGEPRUEFT ("module linked"), never OK. Such a hook owns the process.
 *
 * CLI for shell callers: `node hook-syntax.mts <file>` prints `OK`, `DEFEKT
 * <detail>` or `UNGEPRUEFT <detail>` and exits 0, 1 or 2.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

export type SyntaxVerdict =
  | { state: "OK" }
  | { state: "DEFEKT"; detail: string }
  | { state: "UNGEPRUEFT"; detail: string };

const OK: SyntaxVerdict = { state: "OK" };
// The codes a module request fails with when only resolution stopped it.
const LINK_FAILED = new Set(["ERR_UNSUPPORTED_ESM_URL_SCHEME", "ERR_UNSUPPORTED_RESOLVE_REQUEST", "ERR_MODULE_NOT_FOUND"]);
const TS_REJECTED = new Set(["ERR_INVALID_TYPESCRIPT_SYNTAX", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"]);
// The probe's import attribute is one no module format accepts, so even a
// customization hook that resolves the specifier stops at Node's load step
// (ERR_IMPORT_ATTRIBUTE_UNSUPPORTED) before anything is instantiated (#284).
const PROBE = 'import "kherep-syntax-probe:never" with { type: "kherep-syntax-probe" };';
const HOOK_RESOLVED = "ERR_IMPORT_ATTRIBUTE_UNSUPPORTED";

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
const firstLine = (error: unknown): string =>
  String((error && (error as Error).message) || error).split(/\r?\n/)[0].trim();

// Kept for its callers (live-hook-integrity.mts): since #284 the strip call
// below quiets its own ExperimentalWarning, so there is nothing to do here.
export function quietStripWarning(): void {}

// The stripper announces itself as experimental once per process, through
// process.emitWarning, synchronously, before it parses. Swapping that function
// for the duration of the one call drops exactly that warning and nothing else:
// no listener is touched, a `once` listener stays a once listener, and a
// listener attached later never sees it either (#284). Node marks the warning
// as emitted before it calls emitWarning, so it stays silent for the process.
function withoutStripWarning<T>(run: () => T): T {
  const emit = process.emitWarning;
  const filtered = (warning: string | Error, ...rest: unknown[]): void => {
    const option = rest[0] as string | { type?: string } | undefined;
    const type = typeof option === "string" ? option : option?.type ?? (warning as Error).name;
    const text = typeof warning === "string" ? warning : String(warning?.message);
    if (type === "ExperimentalWarning" && /\bstripTypeScriptTypes\b/.test(text)) return;
    Reflect.apply(emit, process, [warning, ...rest]);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return run();
  } finally {
    process.emitWarning = emit;
  }
}

// The verdict for the error a probe import failed with. Which failing request
// Node reports first differs between versions (26.10 names an unknown builtin
// before the probe, 24.1 the probe), so the mapping is tested on its own.
export function linkFailureVerdict(error: unknown): SyntaxVerdict {
  const code = errorCode(error);
  if (error instanceof SyntaxError && !code) return { state: "DEFEKT", detail: `rejected by Node's parser: ${firstLine(error)}` };
  if (code && LINK_FAILED.has(code)) return OK;
  if (code === HOOK_RESOLVED) return { state: "UNGEPRUEFT", detail: "a module customization hook resolved the probe import; only Node's default loader is trusted" };
  return { state: "UNGEPRUEFT", detail: `${code || (error as Error)?.name || "error"}: ${firstLine(error)}` };
}

// V8's module parse of plain JavaScript. The probe import cannot resolve (or,
// under a hook that resolves it, cannot load), so the graph never links and
// nothing evaluates; a resolution failure means the parse passed. A module that
// DID evaluate is reported, never taken as OK.
export async function esmParses(js: string): Promise<SyntaxVerdict> {
  try {
    await import(`data:text/javascript,${encodeURIComponent(`${js}\n${PROBE}\n`)}`);
  } catch (error) {
    return linkFailureVerdict(error);
  }
  return { state: "UNGEPRUEFT", detail: "module linked; the probe import did not stop evaluation" };
}

function stripVerdict(source: string): SyntaxVerdict | string {
  const strip = (module as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;
  if (typeof strip !== "function") return { state: "UNGEPRUEFT", detail: "this Node has no module.stripTypeScriptTypes" };
  try {
    return withoutStripWarning(() => strip(source));
  } catch (error) {
    const code = errorCode(error);
    if (code && TS_REJECTED.has(code)) return { state: "DEFEKT", detail: `rejected by Node's parser: ${code}: ${firstLine(error)}` };
    return { state: "UNGEPRUEFT", detail: `type stripping failed (${code || "no code"}: ${firstLine(error)})` };
  }
}

// node --check's answer about a script vm.Script rejected. Only a child that ran
// to a non-zero exit on its own and printed a SyntaxError for THIS file is a
// rejection. One that never ran or never finished (ENOENT, ETIMEDOUT, a signal,
// exit 9 for a bad NODE_OPTIONS, a SyntaxError in a preload) proves nothing (#284).
// Node prints a rejection as one block: `<path>:<line>`, the source line, the
// caret line, a blank line, `SyntaxError: ...`. A SyntaxError line counts only
// right after that blank line and when a line within the four above it names
// this file, wherever the block sits, so lines printed before it (NODE_DEBUG, a
// loader warning) and a source line that itself starts with `SyntaxError` are
// ignored (#292).
export function checkFailureVerdict(error: unknown, file: string): SyntaxVerdict {
  const e = (error ?? {}) as { code?: string; status?: number | null; signal?: string | null; stderr?: unknown };
  const lines = String(e.stderr ?? "").split(/\r?\n/).map((l) => l.trim());
  const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ours = new RegExp(`(^|[\\\\/])${escaped}:\\d+$`, process.platform === "win32" ? "i" : "");
  const block = lines.findIndex((l, i) => /^SyntaxError\b/.test(l) && lines[i - 1] === "" && lines.slice(Math.max(0, i - 4), i).some((a) => ours.test(a)));
  if (typeof e.status === "number" && e.status !== 0 && !e.signal && block >= 0) {
    return { state: "DEFEKT", detail: `rejected by node --check: ${lines[block]}` };
  }
  let why = firstLine(error);
  if (e.code) why = e.code;
  else if (e.signal) why = `killed by ${e.signal}`;
  else if (typeof e.status === "number") why = `exit ${e.status}: ${lines.find((l) => l) || "no stderr"}`;
  return { state: "UNGEPRUEFT", detail: `vm.Script rejected it and node --check could not confirm (${why})` };
}

// CommonJS, as in the integrity hook: node --check has the last word over what
// the in-process parse rejected (a top-level return, for instance).
function scriptVerdict(file: string, source: string): SyntaxVerdict {
  try {
    new vm.Script(source, { filename: file });
    return OK;
  } catch {
    /* confirm with node itself */
  }
  // Without NODE_OPTIONS: no preload may print, exit early or forge a rejection;
  // the operator's loader flags are not the syntax contract (#292). Windows
  // environment names are case-insensitive.
  const win = process.platform === "win32";
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => (win ? k.toUpperCase() : k) !== "NODE_OPTIONS"));
  try {
    execFileSync(process.execPath, ["--check", file], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
    return OK;
  } catch (error) {
    return checkFailureVerdict(error, file);
  }
}

// `file` picks the grammar by extension and is the path node --check reads for
// .js and .cjs; `source` is its content.
export async function syntaxVerdict(file: string, source: string): Promise<SyntaxVerdict> {
  if (!source.length) return { state: "DEFEKT", detail: "0 bytes - it runs, enforces nothing and exits 0 (fail-open)" };
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mts") {
    const stripped = stripVerdict(source);
    return typeof stripped === "string" ? esmParses(stripped) : stripped;
  }
  if (ext === ".mjs") return esmParses(source);
  if (ext === ".js" || ext === ".cjs") return scriptVerdict(file, source);
  return { state: "UNGEPRUEFT", detail: `no syntax contract for the extension "${ext}"` };
}

async function cli(file: string | undefined): Promise<number> {
  if (!file) {
    console.log("UNGEPRUEFT usage: node hook-syntax.mts <file>");
    return 2;
  }
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.log(`UNGEPRUEFT unreadable (${errorCode(error) || "unknown"})`);
    return 2;
  }
  const verdict = await syntaxVerdict(file, source);
  console.log(verdict.state === "OK" ? "OK" : `${verdict.state} ${verdict.detail}`);
  return verdict.state === "OK" ? 0 : verdict.state === "DEFEKT" ? 1 : 2;
}

// Same idiom as bootstrap/capability-check.mts: realpath-tolerant, and no main
// flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  cli(process.argv[2]).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.log(`UNGEPRUEFT the check itself failed (${firstLine(error)})`); process.exitCode = 2; }
  );
}
