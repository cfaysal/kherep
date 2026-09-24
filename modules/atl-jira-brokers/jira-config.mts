export type JiraEnv = Record<string, string | undefined>;

export interface JiraBinding {
  site: string;
  projectId: string;
  projectKey: string;
  issueTypes: Record<string, string>;
}

export class JiraConfigError extends Error {}

function required(env: JiraEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new JiraConfigError(`${name} ist nicht gesetzt.`);
  return value.trim();
}

function site(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new JiraConfigError("KHEREP_ATL_SITE ist ungültig."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new JiraConfigError("KHEREP_ATL_SITE muss ein credential-freier HTTPS-Origin sein.");
  }
  return parsed.origin;
}

function issueTypes(value: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new JiraConfigError("KHEREP_ATL_ISSUE_TYPES ist kein gültiges JSON-Objekt."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JiraConfigError("KHEREP_ATL_ISSUE_TYPES ist kein gültiges JSON-Objekt.");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.some(([name, id]) => !name.trim() || typeof id !== "string" || !/^\d+$/.test(id))) {
    throw new JiraConfigError("KHEREP_ATL_ISSUE_TYPES enthält ungültige Namen oder IDs.");
  }
  return Object.fromEntries(entries);
}

export function jiraBinding(env: JiraEnv): JiraBinding {
  const projectId = required(env, "KHEREP_ATL_PROJECT_ID");
  const projectKey = required(env, "KHEREP_ATL_PROJECT_KEY").toUpperCase();
  if (!/^\d+$/.test(projectId)) throw new JiraConfigError("KHEREP_ATL_PROJECT_ID muss numerisch sein.");
  if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey)) throw new JiraConfigError("KHEREP_ATL_PROJECT_KEY ist ungültig.");
  return {
    site: site(required(env, "KHEREP_ATL_SITE")),
    projectId,
    projectKey,
    issueTypes: issueTypes(required(env, "KHEREP_ATL_ISSUE_TYPES")),
  };
}

// The site origin and the project key are operator choices: nothing can derive
// which site and which project this host is meant to talk to. Everything else
// about the project is a property of that site and is read from it.
export interface JiraSeed {
  site: string;
  projectKey: string;
}

export function jiraSeed(env: JiraEnv): JiraSeed {
  const projectKey = required(env, "KHEREP_ATL_PROJECT_KEY").toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey)) throw new JiraConfigError("KHEREP_ATL_PROJECT_KEY ist ungültig.");
  return { site: site(required(env, "KHEREP_ATL_SITE")), projectKey };
}

/**
 * The fully configured binding, or undefined when the discoverable half is
 * absent. A malformed value is still an error: a host that states an id states
 * it correctly or not at all, otherwise a typo would silently reach the site.
 */
export function configuredBinding(env: JiraEnv): JiraBinding | undefined {
  const absent = !env.KHEREP_ATL_PROJECT_ID?.trim() && !env.KHEREP_ATL_ISSUE_TYPES?.trim();
  return absent ? undefined : jiraBinding(env);
}

export function bindingFromSeed(
  seed: JiraSeed,
  discovered: { projectId: string; issueTypes: Record<string, string> },
): JiraBinding {
  if (!/^\d+$/.test(discovered.projectId)) throw new JiraConfigError("Ermittelte Projekt-ID ist nicht numerisch.");
  return { ...seed, projectId: discovered.projectId, issueTypes: issueTypes(JSON.stringify(discovered.issueTypes)) };
}
