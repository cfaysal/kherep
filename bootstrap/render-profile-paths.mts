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
  __KHEREP_REPO__: "repo",
};

interface PortablePaths {
  workspace: string;
  credentialsRoot: string;
  claudeHome: string;
  /** The workspace as a Bash command names it, see workspaceCommandPath. */
  workspaceCommand: string;
  /** The Kherep checkout with the same forward slashes; templates quote it. */
  repo: string;
}

// Issue #31. The Kherep checkout the renderer runs from: install.sh and
// drift-check.sh both call the renderer of the repository being installed, so
// install and drift check render the same path. Hooks that import sibling
// modules, such as the control-plane delivery hook, run from here.
export const KHEREP_REPO = path.resolve(import.meta.dirname, "..");

// Issue #13. A workspace tool run through Bash: `node <workspace>/tools/<tool>`.
// Only this prefix takes the command form; every other workspace placeholder,
// such as the additionalDirectories grant, keeps the native path.
const WORKSPACE_TOOL = "node __KHEREP_WORKSPACE__/tools/";

// Git Bash consumes the backslashes of a native Windows path: node D:\ws/tools/x
// reaches node as D:ws/tools/x, relative to the current directory. Forward
// slashes work in Git Bash, PowerShell and node alike. The Kherep checkout in
// hook commands takes the same form.
function workspaceCommandPath(profile: string, workspace: string): string {
  return resolveProfilePath(profile, workspace).replace(/\\/g, "/");
}

function renderWorkspaceTools(value: string, workspaceCommand: string): string {
  return value.replaceAll(WORKSPACE_TOOL, `node ${workspaceCommand}/tools/`);
}

function rewriteValue(value: unknown, replacements: PortablePaths): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, replacements));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  let rendered = renderWorkspaceTools(value, replacements.workspaceCommand);
  for (const [placeholder, key] of Object.entries(PATH_PLACEHOLDERS)) {
    rendered = rendered.replaceAll(placeholder, replacements[key]);
  }
  return rendered;
}

// Walks any JSON value and rewrites every string in place of its shape: the
// result has the structure of the input, only the string leaves change.
export function substituteTemplatePaths<T>(
  value: T, profile: string, workspace: string, credentialsRoot: string, claudeHome: string, repo: string = KHEREP_REPO,
): T {
  const replacements = {
    workspace: resolveProfilePath(profile, workspace),
    credentialsRoot: resolveProfilePath(profile, credentialsRoot),
    claudeHome: resolveProfilePath(profile, claudeHome),
    workspaceCommand: workspaceCommandPath(profile, workspace),
    repo: workspaceCommandPath(profile, repo),
  };
  return rewriteValue(value, replacements) as T;
}

// The Claude Confluence broker as claude/settings.user.json allows it, rendered
// by the same workspace-tool substitution as those rules. install.sh stores the
// result in confluence.json, and claude-obs runs it verbatim instead of
// composing a path, so the command always matches the allow rule.
const CLAUDE_BROKER_TEMPLATE = `${WORKSPACE_TOOL}atl-confluence-ccoder.mts`;

export function renderClaudeBroker(profile: string, workspace: string): string {
  return renderWorkspaceTools(CLAUDE_BROKER_TEMPLATE, workspaceCommandPath(profile, workspace));
}

export function isMacIncompatiblePermission(value: unknown): boolean {
  return typeof value === "string" && (
    /(?:^|[\s(\"'=])[A-Za-z]:[\\/]/.test(value)
    || /(?:^|[\s(\"'=])\/[A-Za-z]:\//.test(value)
    || /(?:^|[\s(\"'=])\/{1,2}[cd][\\/]/i.test(value)
  );
}
