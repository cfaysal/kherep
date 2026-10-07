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
 * rejects, which is correct for CommonJS.
 *
 * Three states, never merged (goldene Regel 12): OK, DEFEKT (Node's parser
 * rejected it), UNGEPRUEFT (neither proven). A Node without the stripper, or an
 * error this file does not know, is UNGEPRUEFT and never OK.
 * Known limit: link-time SyntaxErrors (`import { nope } from "node:fs"`) are not
 * detected; the probe's failed resolution comes first. `node --check` never
 * caught them either.
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
const PROBE = 'import "kherep-syntax-probe:never";';

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
const firstLine = (error: unknown): string =>
  String((error && (error as Error).message) || error).split(/\r?\n/)[0].trim();

let quieted = false;

// The stripper announces itself as experimental once per process on stderr.
// This drops that one warning and forwards every other one to the listeners
// that were there, Node's printer included. Idempotent.
export function quietStripWarning(): void {
  if (quieted) return;
  quieted = true;
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && /\bstripTypeScriptTypes\b/.test(warning.message)) return;
    for (const listener of listeners) listener.call(process, warning);
  });
}

// The verdict for the error a probe import failed with. Which failing request
// Node reports first differs between versions (26.10 names an unknown builtin
// before the probe, 24.1 the probe), so the mapping is tested on its own.
export function linkFailureVerdict(error: unknown): SyntaxVerdict {
  const code = errorCode(error);
  if (error instanceof SyntaxError && !code) return { state: "DEFEKT", detail: `rejected by Node's parser: ${firstLine(error)}` };
  if (code && LINK_FAILED.has(code)) return OK;
  return { state: "UNGEPRUEFT", detail: `${code || (error as Error)?.name || "error"}: ${firstLine(error)}` };
}

// V8's module parse of plain JavaScript. The probe import cannot resolve, so the
// graph never links and nothing evaluates; a resolution failure means the parse
// passed. A module that DID evaluate is reported, never taken as OK.
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
    return strip(source);
  } catch (error) {
    const code = errorCode(error);
    if (code && TS_REJECTED.has(code)) return { state: "DEFEKT", detail: `rejected by Node's parser: ${code}: ${firstLine(error)}` };
    return { state: "UNGEPRUEFT", detail: `type stripping failed (${code || "no code"}: ${firstLine(error)})` };
  }
}

// CommonJS, unchanged from the integrity hook: node --check has the last word
// over what the in-process parse rejected (a top-level return, for instance).
function scriptVerdict(file: string, source: string): SyntaxVerdict {
  try {
    new vm.Script(source, { filename: file });
    return OK;
  } catch {
    /* confirm with node itself */
  }
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
    return OK;
  } catch (error) {
    const lines = String((error && (error as { stderr?: unknown }).stderr) || "").split(/\r?\n/).map((l) => l.trim());
    return { state: "DEFEKT", detail: `rejected by node --check: ${lines.find((l) => /Error|error:/.test(l)) || "rejected by node --check"}` };
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
  quietStripWarning();
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
