// What a Confluence call promises and how a failed one is named: the two base
// paths, the documented scope per verb, and the error shapes. Split out of
// confluence-session.mts because the two together crossed the 250-line ceiling
// the repository rules set; the cut follows the line that was already there.
// This module answers WHAT a request is and WHAT a failure means, the session
// module answers WHO is calling and HOW the bytes get there.
//
// It lives beside the Jira brokers on purpose - see the header of
// confluence-session.mts for why the directory name is not a mistake.

// The documented scope per verb, verified against the Atlassian OpenAPI spec.
// A 403 names the scope of the verb that was attempted: a missing scope
// reported as a generic failure is the fail-soft behaviour that sends the next
// reader down the wrong path.
export const SCOPES = {
  create: "write:page:confluence",
  update: "write:page:confluence",
  get: "read:page:confluence",
  delete: "delete:page:confluence",
  // purge additionally needs the manage/content space permission. That is a
  // permission, not a scope, so it is not spelled into the scope map.
  purge: "delete:page:confluence",
  // Labels are not writable through v2 at all; the add path is classic v1 and
  // carries the classic scope.
  labels: "write:confluence-content",
  space: "read:space:confluence",
  children: "read:page:confluence",
} as const;

export type Verb = keyof typeof SCOPES;

export function v2(path: string): string {
  return `/wiki/api/v2${path}`;
}

// Classic REST. Still the only writable path for labels.
export function v1(path: string): string {
  return `/wiki/rest/api${path}`;
}

export interface RequestSpec {
  method: string;
  // Path below the site, starting at /wiki. Build it with v2() or v1().
  path: string;
  // The scope this verb needs, named in a 403.
  scope: string;
  body?: unknown;
}

export interface ConfluenceResponse {
  status: number;
  json: unknown;
}

export interface ConfluenceSession {
  request(spec: RequestSpec): Promise<ConfluenceResponse>;
}

// Abort throws instead of ending the process: process.exit inside a module
// would make every failure path untestable. The exit code is set only at the
// CLI boundary.
export class ConfluenceError extends Error {
  cliMessage: string;

  constructor(message: string) {
    super(message);
    this.cliMessage = message;
  }
}

// forbidden and too-large are separate on purpose. A body-too-large failure
// that reads like a permission failure costs the next reader an hour.
export type FailureKind = "forbidden" | "too-large" | "http";

export class ConfluenceRequestError extends ConfluenceError {
  kind: FailureKind;
  status: number;
  method: string;
  path: string;
  scope: string;

  constructor(kind: FailureKind, status: number, spec: RequestSpec, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.method = spec.method;
    this.path = spec.path;
    this.scope = spec.scope;
  }
}

// The message Confluence put in the body, if it put one there. v2 answers with
// {errors:[{title,detail}]}, classic v1 with {message}. Nothing else from the
// body is carried into an error, and no request header ever is - that is what
// keeps the bearer token out of every message below.
export function messageOf(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const body = json as { message?: unknown; errors?: unknown };
  if (typeof body.message === "string" && body.message) return body.message;
  const first = Array.isArray(body.errors) ? body.errors[0] : null;
  if (!first || typeof first !== "object") return "";
  const entry = first as { title?: unknown; detail?: unknown };
  if (typeof entry.detail === "string" && entry.detail) return entry.detail;
  if (typeof entry.title === "string" && entry.title) return entry.title;
  return "";
}

export function requestError(spec: RequestSpec, status: number, json: unknown): ConfluenceRequestError {
  const detail = messageOf(json);
  const suffix = detail ? ` - ${detail}` : "";
  const where = `${spec.method} ${spec.path}`;
  // A missing scope does NOT arrive as 403 on an OAuth app. Measured live on
  // 2026-09-21 against a binding without granular scopes: Atlassian answers 401
  // with "scope does not match". Keying the scope hint on 403 alone left the
  // one error this broker exists to explain reading like a broken credential,
  // which is the opposite diagnosis and sends the next reader to the wrong file.
  if (status === 403 || (status === 401 && /scope/i.test(detail))) {
    return new ConfluenceRequestError("forbidden", status, spec,
      `HTTP ${status} on ${where}: the service account is missing the scope ${spec.scope}${suffix}`);
  }
  if (status === 413) {
    return new ConfluenceRequestError("too-large", status, spec,
      `HTTP 413 on ${where}: the request body exceeds the 5 MB limit. A size failure, not a permission failure${suffix}`);
  }
  return new ConfluenceRequestError("http", status, spec, `HTTP ${status} on ${where}${suffix}`);
}
