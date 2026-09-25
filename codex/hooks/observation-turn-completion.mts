import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";

export interface StopInput {
  stop_hook_active?: unknown;
}

export interface StopDecision {
  decision: "block";
  reason: string;
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderObservationInstruction(workspace: string): string {
  const broker = powershellLiteral(path.join(workspace, "tools", "atl-confluence.mts"));
  return [
    "Dispatch exactly one `codex-obs` with `fork_turns: \"none\"`.",
    "Pass only the completed turn, relevant tool evidence, and compact task state.",
    "Require the worker to return one strict JSON document; the worker performs no config or broker I/O.",
    "Validate the candidate envelope and every title, bodyStorage, evidence, labels, and placement field.",
    "Require placement to contain exactly project and app, and base labels to contain exactly type-observation, evidence-<value>, and status-author-model.",
    "The worker performs no related, create, delete, stitch, or other broker call.",
    "An empty `observations` array means zero writes.",
    "For nonempty candidates, read the canonical Codex Confluence configuration and require observationPublishingAuthorized to be literal `true`.",
    `Then, from this trusted Maestro main thread, use the Codex broker projected into the selected workspace with \`node ${broker}\` for related, create, readback verification, and stitch in the configured space.`,
    "Never dispatch a second pass.",
  ].join(" ");
}

export function decision(input: StopInput, workspace = SELECTED_WORKSPACE): StopDecision | null {
  if (input?.stop_hook_active !== false) return null;
  return { decision: "block", reason: renderObservationInstruction(workspace) };
}

function main(): void {
  let input: StopInput;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8")) as StopInput;
  } catch {
    return;
  }

  const result = decision(input);
  if (result) process.stdout.write(JSON.stringify(result));
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

if (isMainModule()) main();
