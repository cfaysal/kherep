#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createTwgClient, TwgError } from "./client.mts";
import type { TwgClient, TwgClientOptions } from "./client.mts";
import { parseCli } from "./cli-contract.mts";

const HELP = {
  operations: ["status", "jira-get", "jira-search", "confluence-search", "help"],
  usage: {
    status: "status",
    jiraGet: "jira-get OP-123",
    jiraSearch: "jira-search <JQL>",
    confluenceSearch: "confluence-search <text>",
  },
} as const;

interface MainOptions extends TwgClientOptions {
  client?: TwgClient;
}

type MainResult = typeof HELP
  | { ok: true; operation: string; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export async function main(argv: string[] = process.argv.slice(2), options: MainOptions = {}): Promise<MainResult> {
  try {
    const parsed = parseCli(argv);
    if (parsed.operation === "help") return HELP;
    const client = options.client || createTwgClient(options);
    let data: unknown;
    if (parsed.operation === "status") data = await client.status();
    else if ("input" in parsed && parsed.operation === "jira-get") data = await client.jiraGet(parsed.input);
    else if ("input" in parsed && parsed.operation === "jira-search") data = await client.jiraSearch(parsed.input);
    else if ("input" in parsed) data = await client.confluenceSearch(parsed.input);
    else throw new TwgError("TWG_INTERNAL", "The TWG integration failed.");
    return { ok: true, operation: parsed.operation, data };
  } catch (error) {
    const safe = error instanceof TwgError
      ? error
      : new TwgError("TWG_INTERNAL", "The TWG integration failed.");
    return { ok: false, error: { code: safe.code, message: safe.message } };
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
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
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if ("ok" in result && result.ok === false) process.exitCode = result.error.code === "TWG_USAGE" ? 2 : 1;
}
