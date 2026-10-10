// Issue #376. The Atlassian remote MCP server v2, reached as the runtime's own
// Atlassian service account: its API key is a Bearer token in a private file,
// read only by the secret-file wrapper (modules/mcp-auth-bridge). Each runtime
// has its own file and its own variable, never the other runtime's, and never
// a broker credential file: those hold an OAuth client, not an API key.
import fs from "node:fs";
import path from "node:path";

import { tokenFileStatus } from "../modules/mcp-auth-bridge/supergateway-secret-wrapper.mts";

export const ATLASSIAN_MCP_SERVER = "atlassian";
export const ATLASSIAN_MCP_ENDPOINT = "https://mcp.atlassian.com/v2/mcp";

export type AtlassianRuntime = "claude" | "codex";
export interface RuntimeHomes { claude: string; codex: string }

export const MCP_TOKEN_ENV: Record<AtlassianRuntime, string> = {
  claude: "KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE",
  codex: "KHEREP_ATL_MCP_TOKEN_FILE_CODEX",
};
const BROKER_CREDENTIAL_ENV: Record<AtlassianRuntime, string> = {
  claude: "KHEREP_ATL_CRED_FILE_CLAUDE",
  codex: "KHEREP_ATL_CRED_FILE_CODEX",
};

// "shared": the file is also the other runtime's token file or a broker
// credential file. Using it would let one runtime act as the other identity.
export type TokenBindingStatus = "ok" | "missing" | "invalid" | "shared";

export interface TokenBinding {
  runtime: AtlassianRuntime;
  file: string;
  source: "option" | "env" | "default";
  status: TokenBindingStatus;
}

export function defaultTokenFile(runtime: AtlassianRuntime, home: string): string {
  return path.join(home, "kherep", `atl-mcp-credential-${runtime}.txt`);
}

function bound(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function tokenFile(
  runtime: AtlassianRuntime, homes: RuntimeHomes, env: Record<string, string | undefined>,
): string {
  return bound(env, MCP_TOKEN_ENV[runtime]) ?? defaultTokenFile(runtime, homes[runtime]);
}

function brokerFile(
  runtime: AtlassianRuntime, homes: RuntimeHomes, env: Record<string, string | undefined>,
): string {
  return bound(env, BROKER_CREDENTIAL_ENV[runtime])
    ?? path.join(homes[runtime], "kherep", `atl-credential-${runtime}.txt`);
}

function comparable(file: string): string {
  const resolved = path.resolve(file);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* compared as written */ }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function resolveTokenBinding(
  runtime: AtlassianRuntime,
  homes: RuntimeHomes,
  env: Record<string, string | undefined>,
  explicit?: string,
): TokenBinding {
  const fromEnv = bound(env, MCP_TOKEN_ENV[runtime]);
  const file = explicit ?? fromEnv ?? defaultTokenFile(runtime, homes[runtime]);
  const source = explicit !== undefined ? "option" : fromEnv ? "env" : "default";
  const other: AtlassianRuntime = runtime === "claude" ? "codex" : "claude";
  const forbidden = [tokenFile(other, homes, env), brokerFile(runtime, homes, env), brokerFile(other, homes, env)]
    .map(comparable);
  if (path.isAbsolute(file) && forbidden.includes(comparable(file))) {
    return { runtime, file, source, status: "shared" };
  }
  return { runtime, file, source, status: tokenFileStatus(file) };
}

// The operator-facing reason for a binding that is not used. It names the
// variable, never the token.
export function tokenBindingProblem(binding: TokenBinding): string | undefined {
  const variable = MCP_TOKEN_ENV[binding.runtime];
  switch (binding.status) {
    case "ok": return undefined;
    case "missing": return `no Atlassian MCP API key file at ${binding.file} (set ${variable} or create that file)`;
    case "invalid": return `the Atlassian MCP API key file ${binding.file} is not an absolute, private, regular file owned by this user`;
    case "shared": return `${variable} names a file that belongs to another runtime or to a broker credential`;
  }
}
