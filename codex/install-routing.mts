import path from "node:path";
import { pathToFileURL } from "node:url";
import { updateRouting, rollbackRouting } from "./lib/routing-update.mts";

export function main(args = process.argv.slice(2)): void {
  const [mode, ...rest] = args;
  if (!["check", "apply", "rollback"].includes(mode ?? "") || rest.length % 2) throw new Error("invalid routing command");
  const allowed = mode === "rollback" ? ["--codex-home", "--backup-id"] : ["--codex-home", "--config-root", "--example-target"];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || values.has(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error("invalid routing arguments");
    values.set(rest[i], rest[i + 1]);
  }
  if (values.size !== allowed.length) throw new Error("missing routing arguments");
  const codexHome = values.get("--codex-home")!;
  const result = mode === "rollback" ? rollbackRouting({ codexHome, backupId: values.get("--backup-id")! })
    : updateRouting({ codexHome, mode: mode as "check" | "apply", configRoot: values.get("--config-root")!, exampleTarget: values.get("--example-target")! });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch { console.error("Routing update refused; target, render binding or backup evidence did not pass validation."); process.exitCode = 1; }
}
