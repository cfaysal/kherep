// The semantic half of the neighbour search, kept in its own file because it is
// the only part that spawns a process. Everything it returns is a PROPOSAL:
// unranked by any number we can read, site-wide rather than space-wide, and
// filtered afterwards against the space index in confluence-related.mts.
//
// A failed search and a search with no hits are different facts and must not
// collapse into the same empty array (golden rule 12). The reason travels with
// the result, so a caller can say "nothing matched" only when nothing matched.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

export interface Proposals {
  titles: string[];
  // Set when the search could not run. Absent means the search ran; an empty
  // titles list is then a measured result rather than a missing one.
  error?: string;
}

export type ExecLike = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.toString().slice(0, 200) || error.message));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function titlesFrom(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data ?? payload;
  const rows = (data as { results?: unknown; items?: unknown })?.results
    ?? (data as { items?: unknown })?.items
    ?? data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String((row as { title?: unknown })?.title ?? "").trim())
    .filter(Boolean);
}

// Where an installed twg is looked for, injected so a test needs no binary.
export interface TwgLookup {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  homedir?: string;
  exists?: (candidate: string) => boolean;
}

const isFile = (candidate: string) => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;

// Issue #478. A bare "twg" is only found on PATH, and a macOS background job
// runs without ~/.local/bin on it. The order mirrors modules/twg/runtime/
// resolve-binary.mts, which cannot be imported from the flat tools directory:
// KHEREP_TWG_BIN, then PATH, then the documented install locations. A set but
// unusable override fails closed rather than silently running another binary.
// On Windows only twg.exe qualifies: a .cmd shim would need a shell.
export function resolveTwg(lookup: TwgLookup = {}): string {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const home = lookup.homedir ?? osHomedir();
  const exists = lookup.exists ?? isFile;
  const paths = platform === "win32" ? win32 : posix;

  const explicit = env.KHEREP_TWG_BIN;
  if (explicit !== undefined) {
    if (!paths.isAbsolute(explicit) || !exists(explicit)) {
      throw new Error("KHEREP_TWG_BIN is not an absolute path to an existing file");
    }
    return explicit;
  }

  const name = platform === "win32" ? "twg.exe" : "twg";
  const onPath = String(env.PATH ?? "").split(paths.delimiter).filter(Boolean)
    .map((entry) => paths.join(entry, name));
  const installed = platform === "win32"
    ? [
      paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "Programs", "twg", "bin", "twg.exe"),
      paths.join(env.ProgramFiles || "C:\\Program Files", "twg", "twg.exe"),
    ]
    : [paths.join(home, ".local", "bin", "twg"), "/opt/homebrew/bin/twg", "/usr/local/bin/twg"];
  const found = [...onPath, ...installed].find(exists);
  if (!found) throw new Error("twg not found on KHEREP_TWG_BIN, PATH or the install locations");
  return found;
}

export interface SemanticDeps extends TwgLookup {
  exec?: ExecLike;
  read?: (path: string) => Promise<string>;
  remove?: (path: string) => Promise<void>;
  // Injected so the file name is deterministic in a test.
  outFile?: string;
  cli?: string;
}

// The site-wide limit is deliberately generous: the space filter happens
// afterwards against the index, so a narrow limit here would spend the whole
// budget on pages that are not in the space at all.
export async function semanticProposals(
  query: string,
  limit = 25,
  deps: SemanticDeps = {},
): Promise<Proposals> {
  const exec = deps.exec ?? execFileAsync;
  const read = deps.read ?? ((path: string) => readFile(path, "utf8"));
  const remove = deps.remove ?? ((path: string) => rm(path, { force: true }));
  const out = deps.outFile ?? join(tmpdir(), `kherep-related-${process.pid}.json`);

  // The query is a page title, and a title that starts with a dash would be
  // read by the CLI as a flag rather than as a search term. The end-of-options
  // separator settles it, and the explicit refusal covers a CLI that does not
  // honour one - a title is data and must never decide which flags run.
  if (query.startsWith("-")) {
    return { titles: [], error: "semantic search refused a query that starts with a dash" };
  }

  try {
    const cli = deps.cli ?? resolveTwg(deps);
    await exec(cli, [
      "rovo", "search",
      "--app", "confluence",
      "--limit", String(limit),
      "-o", "json",
      "--output-file", out,
      "--", query,
    ], { timeout: 90_000 });
  } catch (error) {
    return { titles: [], error: `semantic search did not run: ${(error as Error).message}` };
  }

  try {
    const titles = titlesFrom(JSON.parse(await read(out)));
    return { titles };
  } catch (error) {
    return { titles: [], error: `semantic search wrote no readable result: ${(error as Error).message}` };
  } finally {
    await remove(out).catch(() => {});
  }
}
