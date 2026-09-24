import { JiraConfigError } from "./jira-config.mts";

// The numeric project id and the issue-type ids are properties of the site, not
// operator preferences: they can only be read from the site that owns them.
// Requiring them as configuration meant every new workstation had to transcribe
// two values by hand before the broker could run at all.
//
// This resolves them through the caller's already authenticated API function, so
// no credential handling is duplicated here and the discovery is testable with a
// plain stub.
export interface DiscoveredProject {
  readonly projectId: string;
  readonly issueTypes: Record<string, string>;
}

/** A single authenticated GET against the site's REST base, returning parsed JSON. */
export type JiraGet = (path: string) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rows(value: unknown, ...keys: string[]): Record<string, unknown>[] {
  const holder = record(value);
  if (!holder) return [];
  for (const key of keys) {
    const candidate = holder[key];
    if (!Array.isArray(candidate)) continue;
    const found: Record<string, unknown>[] = [];
    for (const item of candidate) {
      const entry = record(item);
      if (entry) found.push(entry);
    }
    return found;
  }
  return [];
}

function numericId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  return /^\d+$/.test(text) ? text : undefined;
}

/**
 * Reads the project id and the issue-type map for one project key.
 *
 * Both calls are scoped to that single key, so a service account with access to
 * many projects still cannot widen this into a site inventory.
 */
export async function discoverProject(get: JiraGet, projectKey: string): Promise<DiscoveredProject> {
  const found = rows(await get(`/project/search?keys=${encodeURIComponent(projectKey)}`), "values")
    .find(row => row.key === projectKey);
  if (!found) throw new JiraConfigError(`Projekt ${projectKey} ist für dieses Konto nicht sichtbar.`);
  const projectId = numericId(found.id);
  if (!projectId) throw new JiraConfigError(`Projekt ${projectKey} lieferte keine numerische ID.`);

  const issueTypes: Record<string, string> = {};
  for (const type of rows(await get(`/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`),
    "issueTypes", "values")) {
    const id = numericId(type.id);
    const name = typeof type.name === "string" ? type.name.trim() : "";
    // Last write wins only for an exact duplicate name; Jira does not allow two
    // creatable types with the same name inside one project.
    if (id && name) issueTypes[name] = id;
  }
  if (Object.keys(issueTypes).length === 0) {
    throw new JiraConfigError(`Projekt ${projectKey} lieferte keine anlegbaren Vorgangstypen.`);
  }
  return { projectId, issueTypes };
}
