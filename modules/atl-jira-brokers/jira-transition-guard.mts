// OP-1124: the transition guard now carries its types. The three shapes below
// are the whole contract between the brokers and this module: what a caller may
// ask for (TransitionIntentOptions), what it gets back once the ask is proven
// well-formed (TransitionIntent) and what a Jira transition listing looks like
// as far as the selection cares (TransitionCandidate).

export type StatusCategoryKey = "new" | "indeterminate" | "done";

// The raw CLI options. Both brokers parse argv into a string record, so every
// field arrives as string | undefined and is narrowed here, not by the caller.
export interface TransitionIntentOptions {
  to?: unknown;
  acceptance?: unknown;
}

export interface TransitionIntent {
  category: StatusCategoryKey;
  acceptance: string | null;
}

// Exactly one of the two keys is set. A caller that reads `intent` without
// checking `error` gets undefined, not a half-built intent.
export interface TransitionIntentResult {
  error?: string;
  intent?: TransitionIntent;
}

// Jira's GET /issue/{key}/transitions payload, narrowed to the fields the
// selection reads. id and to.id are declared as string by the v3 spec but are
// compared through String() anyway, so a number cannot slip past unnoticed.
export interface TransitionCandidate {
  id?: string | number;
  name?: string;
  to?: {
    id?: string | number;
    name?: string;
    statusCategory?: { key?: string };
  };
}

// Neither key is set when the category matches nothing at all.
export interface TransitionSelection {
  selected?: TransitionCandidate;
  ambiguous?: TransitionCandidate[];
}

const STATUS_CATEGORY_KEYS = new Set<string>(["new", "indeterminate", "done"]);
const JIRA_REFERENCE = /^(jira-comment|jira-changelog):[1-9][0-9]*$/;
const DIRECTOR_PREFIX = "director-statement:";

function isStatusCategory(value: string): value is StatusCategoryKey {
  return STATUS_CATEGORY_KEYS.has(value);
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidAcceptance(value: string): boolean {
  if (JIRA_REFERENCE.test(value)) return true;
  return value.startsWith(DIRECTOR_PREFIX)
    && isValidIsoDate(value.slice(DIRECTOR_PREFIX.length));
}

export function validateTransitionIntent(options: TransitionIntentOptions = {}): TransitionIntentResult {
  const category = typeof options.to === "string" ? options.to.trim().toLowerCase() : "";
  if (!isStatusCategory(category)) {
    return { error: "--to muss eine Jira-Statuskategorie sein: new | indeterminate | done." };
  }

  const acceptance = typeof options.acceptance === "string" ? options.acceptance.trim() : "";
  if (acceptance && !isValidAcceptance(acceptance)) {
    return { error: "--acceptance muss jira-comment:<ID>, jira-changelog:<ID> oder director-statement:<YYYY-MM-DD> sein." };
  }
  if (category === "done" && !acceptance) {
    return { error: "Done-Transition abgewiesen: --acceptance fehlt." };
  }

  return { intent: { category, acceptance: acceptance || null } };
}

export function selectTransitionByCategory(transitions: unknown, category: string): TransitionSelection {
  const list: TransitionCandidate[] = Array.isArray(transitions) ? transitions : [];
  const matches = list.filter((candidate) => (
    candidate?.to?.statusCategory?.key === category
  ));
  if (matches.length === 1) return { selected: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return {};
}

export function doneAuditText(acceptance: string | null): string {
  return `Done-Transition durch Kherep Jira-Service-Account-Broker.\n\nAbnahmebeleg: ${acceptance}`;
}
