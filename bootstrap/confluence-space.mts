#!/usr/bin/env node
/** Resolve and persist the Confluence knowledge space for one runtime. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLACEMENT_NODES, readSpacePages, resolvePlacement } from "./confluence-nodes.mts";

const ENV_KEY = "KHEREP_CONFLUENCE_SPACE_KEY";

export type Runtime = "claude" | "codex";

export interface SetupArgs {
  out: string;
  runtime: Runtime;
  existing?: string;
  authorizeObservationPublishing: boolean;
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
  return {
    out,
    runtime,
    existing: argValue(argv, "--existing"),
    authorizeObservationPublishing: argv.includes("--authorize-observation-publishing"),
  };
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

function storedObservationPublishingAuthority(file: string, resolvedSpaceId: string): boolean {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      observationPublishingAuthorized?: unknown;
      spaceId?: unknown;
    };
    return stored.observationPublishingAuthorized === true
      && stored.spaceId === resolvedSpaceId;
  } catch {
    throw new Error("Existing Confluence space configuration could not be read.");
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

function storedNodes(file: string, resolvedSpaceId: string): Record<string, string> {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return {};
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      spaceId?: unknown;
      nodes?: unknown;
    };
    if (stored.spaceId !== resolvedSpaceId || !stored.nodes || typeof stored.nodes !== "object"
      || Array.isArray(stored.nodes)) return {};
    return Object.fromEntries(Object.entries(stored.nodes).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"));
  } catch {
    throw new Error("Existing Confluence space configuration could not be read.");
  }
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
  const requested = selectSpaceKey({ target: args.out, existing: args.existing });
  const space = resolveSpace(requested, args.runtime);
  const observationPublishingAuthorized = args.authorizeObservationPublishing
    || storedObservationPublishingAuthority(args.out, space.id);
  const nodes = await resolveNodes(space.id, args.runtime, storedNodes(args.out, space.id));
  try {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify({
      spaceKey: space.key,
      spaceId: space.id,
      spaceName: space.name,
      nodes,
      ...(observationPublishingAuthorized ? { observationPublishingAuthorized: true } : {}),
    }, null, 2)}\n`, "utf8");
  } catch {
    throw new Error("Confluence space configuration could not be written.");
  }
  process.stdout.write("confluence space: configured\n");
  process.stdout.write(`placement nodes: ${Object.keys(nodes).length} of ${PLACEMENT_NODES.length} resolved\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
