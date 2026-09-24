import fs from "node:fs";
import { decision } from "./acceptance-policy.mts";

export { decision } from "./acceptance-policy.mts";
export type { StopInput, StopDecision } from "./acceptance-policy.mts";

function main(): void {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const result = decision(input);
  if (result) process.stdout.write(JSON.stringify(result));
}

if (import.meta.main) main();
