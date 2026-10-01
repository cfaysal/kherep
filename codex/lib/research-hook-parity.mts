import fs from "node:fs";
import path from "node:path";

const RESEARCH_HOOKS = ["research-first.mts", "research-stop.mts"] as const;

// This check is intentionally narrow: it covers only the two evidence-first
// enforcement counterparts named by issue #169, not generic runtime parity.
export function assertResearchHookParity(repoRoot: string): void {
  const missing: string[] = [];
  for (const runtime of ["claude", "codex"]) for (const name of RESEARCH_HOOKS) {
    const relative = `${runtime}/hooks/${name}`;
    if (!fs.existsSync(path.join(repoRoot, relative))) missing.push(relative);
  }
  if (missing.length) throw new Error(`Research hook parity is incomplete: missing ${missing.join(", ")}`);
}
