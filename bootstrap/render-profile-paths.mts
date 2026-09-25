// Portable placeholder rendering for versioned settings. Host-specific paths
// are supplied by the installer and never embedded in source templates.

import path from "node:path";

import { isRecord } from "./shape.mts";

export function isMacPosixDirectory(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !/^\/[A-Za-z]:\//.test(value)
    && !/^\/[cd](?:\/|$)/i.test(value)
    && !value.includes("\\");
}

export function resolveProfilePath(profile: string, value: string): string {
  if (profile !== "mac") return path.resolve(value);
  let normalized = String(value).replace(/\\/g, "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) normalized = `/${drive[1].toLowerCase()}/${drive[2]}`;
  return path.posix.resolve(normalized);
}

// OP-754. Bash-sichtbare Form: Backslashes zu Schraegstrichen, fuehrendes
// Laufwerk zu /<buchstabe>/. Nur der Laufwerksbuchstabe wird kleingeschrieben;
// der Rest bleibt unangetastet, weil POSIX-Dateisysteme case-sensitiv sind.
// Ein bereits absoluter POSIX-Pfad geht unveraendert durch.
export function toBashPath(value: string): string {
  const slashed = String(value).replace(/\\/g, "/");
  const drive = slashed.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : slashed;
}

const PATH_PLACEHOLDERS: Record<string, keyof PortablePaths> = {
  __KHEREP_WORKSPACE__: "workspace",
  __KHEREP_CREDENTIALS_ROOT__: "credentialsRoot",
  __KHEREP_CLAUDE_HOME__: "claudeHome",
};

interface PortablePaths {
  workspace: string;
  credentialsRoot: string;
  claudeHome: string;
}

function rewriteValue(value: unknown, replacements: PortablePaths): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, replacements));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  let rendered = value;
  for (const [placeholder, key] of Object.entries(PATH_PLACEHOLDERS)) {
    rendered = rendered.replaceAll(placeholder, replacements[key]);
  }
  return rendered;
}

// Walks any JSON value and rewrites every string in place of its shape: the
// result has the structure of the input, only the string leaves change.
export function substituteTemplatePaths<T>(
  value: T, profile: string, workspace: string, credentialsRoot: string, claudeHome: string,
): T {
  const replacements = {
    workspace: resolveProfilePath(profile, workspace),
    credentialsRoot: resolveProfilePath(profile, credentialsRoot),
    claudeHome: resolveProfilePath(profile, claudeHome),
  };
  return rewriteValue(value, replacements) as T;
}

// Issue #13. The Claude Confluence broker as claude/settings.user.json allows
// it, rendered by the same workspace substitution as those rules. install.sh
// stores the result in confluence.json, and claude-obs runs it verbatim instead
// of composing a path, so the command always matches the allow rule.
const CLAUDE_BROKER_TEMPLATE = "node __KHEREP_WORKSPACE__/tools/atl-confluence-ccoder.mts";

export function renderClaudeBroker(profile: string, workspace: string): string {
  return CLAUDE_BROKER_TEMPLATE.replaceAll("__KHEREP_WORKSPACE__", resolveProfilePath(profile, workspace));
}

export function isMacIncompatiblePermission(value: unknown): boolean {
  return typeof value === "string" && (
    /(?:^|[\s(\"'=])[A-Za-z]:[\\/]/.test(value)
    || /(?:^|[\s(\"'=])\/[A-Za-z]:\//.test(value)
    || /(?:^|[\s(\"'=])\/{1,2}[cd][\\/]/i.test(value)
  );
}
