import { parseArgs } from "node:util";

import { readAttribution, type AttributionRecord } from "./attribution.mts";
import type { NodePaths } from "./config.mts";

// Issue #325, PR-A. `kherep-node attribution` reads the local attribution log
// (attribution.mts): which session pushed a branch or opened a PR on this host.
// Filters combine; records print oldest first.
export const ATTRIBUTION_USAGE = `usage:
  kherep-node attribution [--branch <name>] [--pr <number>] [--repo <owner/name>] [--since <hours>] [--json]`;

export interface AttributionCliDeps {
  paths: NodePaths;
  now?: () => number;
  write?: (text: string) => void;
  warn?: (text: string) => void;
}

const HOUR = 60 * 60_000;

function line(record: AttributionRecord): string {
  return [record.ts, record.kind, record.repo ?? "-", record.branch ?? "-", record.sha?.slice(0, 7) ?? "-",
    record.pr === null ? "-" : `#${record.pr}`, `${record.runtime}:${record.sessionId}`, `(${record.sessionSource})`].join(" ");
}

export function runAttribution(argv: string[], deps: AttributionCliDeps): number {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const warn = deps.warn ?? ((text: string) => process.stderr.write(text));
  let values: { branch?: string; pr?: string; repo?: string; since?: string; json?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      branch: { type: "string" }, pr: { type: "string" }, repo: { type: "string" }, since: { type: "string" },
      json: { type: "boolean" },
    } }));
  } catch {
    warn(`${ATTRIBUTION_USAGE}\n`);
    return 2;
  }
  const pr = values.pr === undefined ? undefined : Number(values.pr);
  const since = values.since === undefined ? undefined : Number(values.since);
  if ((pr !== undefined && !(Number.isSafeInteger(pr) && pr > 0)) || (since !== undefined && !(since >= 0))) {
    warn(`${ATTRIBUTION_USAGE}\n`);
    return 2;
  }
  const after = since === undefined ? -Infinity : (deps.now?.() ?? Date.now()) - since * HOUR;
  // A push records the local branch and the remote ref; a PR's head is the latter.
  const onBranch = (record: AttributionRecord): boolean => values.branch === undefined
    || record.branch === values.branch || record.remoteRef === `refs/heads/${values.branch}`;
  const records = readAttribution(deps.paths).filter((record) => onBranch(record)
    && (pr === undefined || record.pr === pr) && (values.repo === undefined || record.repo === values.repo)
    && Date.parse(record.ts) >= after);
  if (values.json) write(`${JSON.stringify(records, null, 2)}\n`);
  else if (records.length) write(`${records.map(line).join("\n")}\n`);
  return 0;
}
