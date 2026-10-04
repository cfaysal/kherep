import fs from "node:fs";

import type { CredentialPowerShellDeps } from "./mcp-credential-file.mts";

// Shared fixture of the MCP credential tests (issue #219, measurements in MCP.md): tests
// inject fakePowerShell; only integration tests that must start the real helper pass
// REAL_POWERSHELL, a test-only limit. Production keeps its 5 s.
export const REAL_POWERSHELL: CredentialPowerShellDeps = { timeoutMs: 30_000 };
export const OWN_SID = "S-1-5-21-1000";

export interface PowerShellCall {
  command: string;
  args: string[];
  options: { input?: string | Uint8Array; env?: NodeJS.ProcessEnv; encoding?: string; windowsHide?: boolean;
    timeout?: number; maxBuffer?: number };
}

export const success = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "", error: undefined });

// Stands in for the helper: the write creates the temporary file from stdin, an ACL
// check reports the given rules for the current user.
export function fakePowerShell(rules = [{ sid: OWN_SID, allow: true, rights: 1 }]) {
  const calls: PowerShellCall[] = [];
  const spawn = (command: string, args: string[], options: PowerShellCall["options"]) => {
    calls.push({ command, args, options });
    const temp = options.env?.KHEREP_MCP_CREDENTIAL_TEMP;
    if (temp) fs.writeFileSync(temp, options.input ?? "", { flag: "wx" });
    const stdout = temp ? "" : JSON.stringify({ user: OWN_SID, owner: OWN_SID, rules });
    return success(stdout);
  };
  return { calls, spawn };
}
