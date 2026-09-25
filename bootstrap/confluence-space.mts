#!/usr/bin/env node
/** Resolve and persist the Confluence knowledge space for one runtime. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLACEMENT_NODES, readSpacePages, resolvePlacement } from "./confluence-nodes.mts";
import { renderClaudeBroker } from "./render-profile-paths.mts";
import { isRecord, type JsonRecord } from "./shape.mts";

const ENV_KEY = "KHEREP_CONFLUENCE_SPACE_KEY";

export type Runtime = "claude" | "codex";

export interface SetupArgs {
  out: string;
  runtime: Runtime;
  existing?: string;
  authorizeObservationPublishing: boolean;
  /** Claude only: the absolute broker command claude-obs runs, stored as `broker`. */
  broker?: string;
  /** Claude only: merge `broker` into the file and touch nothing else. */
  brokerOnly?: boolean;
}

export interface BrokerIO {
  exists(file: string): boolean;
  run(broker: string, args: readonly string[]): string;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseArgs(argv: string[]): SetupArgs {
  const out = argValue(argv, "--out");
  if (!out) throw new Error("--out <file> is required.");
  const runtime = argValue(argv, "--runtime");
  if (runtime !== "claude" && runtime !== "codex") {
    throw new Error("--runtime must be claude or codex.");
  }
  const args: SetupArgs = {
    out,
    runtime,
    existing: argValue(argv, "--existing"),
    authorizeObservationPublishing: argv.includes("--authorize-observation-publishing"),
  };
  if (runtime === "claude") args.broker = claudeBroker(argValue(argv, "--profile"), argValue(argv, "--workspace"));
  if (argv.includes("--broker-only")) {
    if (runtime !== "claude") throw new Error("--broker-only is Claude-only: only claude-obs reads a broker command.");
    args.brokerOnly = true;
  }
  return args;
}

// Issue #13. Takes the profile and workspace install.sh renders the permission
// rules from, so the stored command is the prefix of those rules.
function claudeBroker(profile: string | undefined, workspace: string | undefined): string {
  if ((profile !== "win" && profile !== "mac") || !workspace) {
    throw new Error("--runtime claude needs --profile <win|mac> and --workspace <path>: "
      + "claude-obs reads its broker command from this file.");
  }
  return renderClaudeBroker(profile, workspace);
}

function promptForKey(): string {
  if (!process.stdin.isTTY) {
    throw new Error(`${ENV_KEY} is required. Set it to the Confluence space key that holds this host's `
      + `knowledge base, for example ${ENV_KEY}=KB. Without a space the observation agents `
      + "have nowhere to write.");
  }
  process.stdout.write("Confluence knowledge space key (e.g. KB): ");
  const buffer = Buffer.alloc(256);
  let read = 0;
  try {
    read = fs.readSync(0, buffer, 0, buffer.length, null);
  } catch {
    throw new Error(`Could not read the space key from the terminal. Set ${ENV_KEY} instead.`);
  }
  const value = buffer.subarray(0, read).toString("utf8").trim();
  if (!value) throw new Error("No space key given.");
  return value;
}

function storedSpaceKey(file: string | undefined): string | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { spaceKey?: string };
    return stored.spaceKey?.trim() || undefined;
  } catch {
    throw new Error("Existing Confluence space configuration could not be read.");
  }
}

// The existing file as an object, or {} when there is none. Every write merges
// into it instead of rebuilding it, so keys another writer added survive
// (issue #13). A file that exists but is no readable JSON object stops the
// step: a merge over it would silently drop what it holds.
function storedConfig(file: string): JsonRecord {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // Unreadable or not JSON: refused below.
  }
  throw new Error("Existing Confluence space configuration could not be read.");
}

function writeConfig(file: string, config: JsonRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    throw new Error("Confluence space configuration could not be written.");
  }
}

export function selectSpaceKey(
  files: { target: string; existing?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[ENV_KEY]?.trim()
    || storedSpaceKey(files.target)
    || storedSpaceKey(files.existing)
    || promptForKey();
}

export function brokerPath(runtime: Runtime, repoRoot = path.join(import.meta.dirname, "..")): string {
  const broker = runtime === "codex" ? "atl-confluence.mts" : "atl-confluence-ccoder.mts";
  return path.join(repoRoot, "modules", "atl-jira-brokers", broker);
}

const defaultBrokerIO: BrokerIO = {
  exists: fs.existsSync,
  run: (broker, args) => execFileSync(process.execPath, [broker, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }),
};

/** Resolve through the service-account broker that writes observations. */
export function resolveSpace(
  key: string,
  runtime: Runtime,
  io: BrokerIO = defaultBrokerIO,
): { id: string; key: string; name: string } {
  const broker = brokerPath(runtime);
  if (!io.exists(broker)) throw new Error("Confluence broker is unavailable.");
  let stdout = "";
  try {
    stdout = io.run(broker, ["space", "--space", key]);
  } catch {
    throw new Error("Confluence space is unreadable by the service account.");
  }
  const field = (name: string): string => {
    const line = stdout.split(/\r?\n/).find((row) => row.startsWith(`${name}: `));
    return line ? line.slice(name.length + 2).trim() : "";
  };
  const id = field("id");
  if (!id) throw new Error("Confluence broker returned an invalid space response.");
  return { id, key: field("key") || key, name: field("name") };
}

function storedNodes(stored: JsonRecord, resolvedSpaceId: string): Record<string, string> {
  if (stored.spaceId !== resolvedSpaceId || !isRecord(stored.nodes)) return {};
  return Object.fromEntries(Object.entries(stored.nodes).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"));
}

async function resolveNodes(
  spaceId: string, runtime: Runtime, previous: Record<string, string>,
): Promise<Record<string, string>> {
  const credential = runtime === "codex" ? "KHEREP_ATL_CRED_FILE_CODEX" : "KHEREP_ATL_CRED_FILE_CLAUDE";
  const pages = await readSpacePages(credential, spaceId).catch(() => {
    process.stderr.write("placement nodes: UNKNOWN - the space could not be read; the prior map is kept.\n");
    return null;
  });
  if (pages === null) return previous;
  const { nodes, missing } = resolvePlacement(pages);
  for (const name of missing) {
    process.stderr.write(`placement node NOT FOUND: ${name} - observations for that branch cannot be placed until it exists.\n`);
  }
  return nodes;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.authorizeObservationPublishing && args.runtime !== "codex") {
    throw new Error("Observation publishing authority is Codex-only.");
  }
  if (args.brokerOnly && args.broker) {
    // Issue #13. install.sh runs this on every Claude install, apart from the
    // credential and space steps: no broker call, no prompt, only `broker` changes.
    writeConfig(args.out, { ...storedConfig(args.out), broker: args.broker });
    process.stdout.write("confluence broker: configured\n");
    return;
  }
  const requested = selectSpaceKey({ target: args.out, existing: args.existing });
  const space = resolveSpace(requested, args.runtime);
  // Publishing authority is re-derived for the resolved space, never carried by the merge.
  const { observationPublishingAuthorized: storedAuthority, ...kept } = storedConfig(args.out);
  const observationPublishingAuthorized = args.authorizeObservationPublishing
    || (storedAuthority === true && kept.spaceId === space.id);
  const nodes = await resolveNodes(space.id, args.runtime, storedNodes(kept, space.id));
  writeConfig(args.out, {
    ...kept,
    spaceKey: space.key,
    spaceId: space.id,
    spaceName: space.name,
    ...(args.broker ? { broker: args.broker } : {}),
    nodes,
    ...(observationPublishingAuthorized ? { observationPublishingAuthorized: true } : {}),
  });
  process.stdout.write("confluence space: configured\n");
  process.stdout.write(`placement nodes: ${Object.keys(nodes).length} of ${PLACEMENT_NODES.length} resolved\n`);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
