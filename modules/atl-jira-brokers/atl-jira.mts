#!/usr/bin/env node
// Public Jira broker. Credential values are read only through KHEREP_ATL_CRED_FILE_CODEX.
// Paths, credentials, and access tokens must never be printed.
import { realpathSync } from "node:fs";
import { readFile as nodeReadFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AtlassianCredentialError,
  parseCredentialText,
  type AtlassianCredentials,
} from "./atlassian-credentials.mts";
import { renderAdf } from "./jira-adf.mts";
import { DESCRIPTION_UNREADABLE, adfToText } from "./jira-adf-text.mts";
import {
  JiraConfigError,
  bindingFromSeed,
  configuredBinding,
  jiraSeed,
  type JiraBinding,
  type JiraSeed,
} from "./jira-config.mts";
import { discoverProject } from "./jira-discovery.mts";
import {
  DEFAULT_ISSUE_FIELDS,
  componentCatalogPath,
  fieldEdits,
  fieldListOr,
  parseAssignee,
  parseFieldList,
  readbackColumns,
  resolveComponentNames,
  verifyReadback,
  type FieldPlan,
  type IssueFields,
} from "./jira-fields.mts";
import {
  attachmentPath,
  confirmAttachments,
  partContentType,
  readAttachments,
  uploadRequest,
  type UploadRequest,
} from "./jira-attach.mts";
import {
  attachmentContentPath,
  attachmentListPath,
  decideOutput,
  readAttachmentList,
  selectAttachment,
  verifyDownload,
} from "./jira-download.mts";
import { boundedMaxResults, readPage, searchFields, searchPath } from "./jira-search.mts";
import {
  doneAuditText,
  selectTransitionByCategory,
  validateTransitionIntent,
  type TransitionCandidate,
} from "./jira-transition-guard.mts";
import {
  LINK_PATH,
  LINK_TYPE_CATALOG_PATH,
  confirmLinkCreated,
  confirmLinkRemoved,
  describeLink,
  linkDeletePath,
  linkReadbackPath,
  linkRequestBody,
  parseLinkOptions,
  resolveLinkType,
  selectLinkToRemove,
  type LinkPlan,
  type LinkType,
} from "./jira-links.mts";

export { parseCredentialText };

const AUTH_URL = "https://auth.atlassian.com/oauth/token";
const API_ROOT = "https://api.atlassian.com/ex/jira";

function productEnv(env: Record<string, string | undefined>, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}
// OP-1124. The injected surface is declared structurally, not as node's fetch and
// node's readFile: the tests hand over stubs that answer exactly these members,
// and a wider type would force them to build a whole Response to say "status 401".
export interface HttpResponse {
  status: number;
  text(): Promise<string>;
  // OP-1396. Only the attachment download reads a body as bytes, and reading it
  // as text would corrupt every byte outside ASCII. Optional so the stubs that
  // answer the JSON verbs need not grow a member they never serve - but a stub
  // that omits it on the download path produces a named error rather than an
  // empty file, because a body nobody could read must not look like a body that
  // was empty (rule 12).
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

export type FetchLike = (url: string, options?: RequestOptions) => Promise<HttpResponse>;
export type ReadFileLike = (path: string, encoding: "utf8") => Promise<string>;
// OP-1396. An upload reads bytes, not text. Declared as its own member rather
// than as a second overload of readFile so a stub cannot answer a binary read
// with a string and have it pass unnoticed.
export type ReadBytesLike = (path: string) => Promise<Buffer>;

export interface BrokerDeps {
  env: Record<string, string | undefined>;
  readFile: ReadFileLike;
  readBytes: ReadBytesLike;
  // Whether stdout is a terminal. The last gate before opaque bytes are printed.
  stdoutIsTty: () => boolean;
  fetch: FetchLike;
  jira?: JiraBinding;
  seed?: JiraSeed;
}

// Everything this broker reads out of a JSON payload, from the token endpoint,
// from tenant_info and from the Jira API alike - requestJson is one function, so
// the shape is one type. A payload that does not carry a field leaves it
// undefined; nothing here is proven by the type, only described.
interface UserLike {
  accountType?: string;
  displayName?: string;
}

interface StatusLike {
  id?: string | number;
  name?: string;
}

export interface JiraPayload {
  access_token?: string;
  error?: string;
  error_description?: string;
  errorMessages?: unknown[];
  errors?: Record<string, unknown>;
  cloudId?: string;
  key?: string;
  id?: string | number;
  accountType?: string;
  displayName?: string;
  author?: UserLike;
  fields?: IssueFields & { summary?: unknown; creator?: UserLike; status?: StatusLike; issuelinks?: unknown; parent?: { key?: string } };
  transitions?: TransitionCandidate[];
}

interface JsonResponse {
  status: number;
  json: JiraPayload;
}

// The JSON object that leaves the process on stdout. Deliberately open: each
// command contributes its own evidence fields, and the filter that decides what
// may appear is errorFields below, not this type.
export type CliOutput = Record<string, unknown>;

export interface CliResult {
  exitCode: number;
  output: CliOutput;
  // OP-1396. THE DOWNLOAD CONTRACT: stdout carries attachment bytes and nothing
  // else, so `download | ...` is the file and not the file plus a JSON envelope.
  // The bytes ride back on the result instead of being written from inside the
  // command, which keeps every byte assertable from a test that owns no process.
  // When they are present the CLI boundary below sends the envelope to stderr.
  stdoutBytes?: Buffer;
}

// The write body of a create or update: the shared field edits plus whatever the
// command adds on top (project, issuetype, summary, description, parent).
type WriteFields = Record<string, unknown>;

interface Identity {
  accountType?: string;
  displayName?: string;
}

interface TokenStep extends ErrorFields {
  status: number;
  tokenLength: number;
}

interface ErrorFields {
  error?: string;
  errorDescription?: string;
  errorMessages?: string[];
  errors?: Record<string, string>;
}

class CliFailure extends Error {
  output: CliOutput;

  constructor(output: CliOutput) {
    super("safe cli failure");
    this.output = output;
  }
}

// Declared `never`: every caller below relies on this not returning, and saying
// so is what lets the checks read as guards instead of needing a second branch.
function stop(error: string, status = 0, extra: CliOutput = {}): never {
  throw new CliFailure({ status, ...extra, error });
}

// OP-928: the body is rendered by the shared block renderer, so a heading, a list
// or a code fence written into a description or comment arrives as that structure
// instead of one run-on paragraph. The name stays for the callers and the tests.
export const toAdf = renderAdf;
export const selectTransition = selectTransitionByCategory;

// Accept-Language nur auf den authentifizierten Jira-Aufrufen: ohne den Header
// traegt die Anfrage gar keine Sprachpraeferenz - node fetch setzt von sich aus
// keine - und Jira liefert Status- und Transition-Namen in einer Sprache, die
// wir nicht kontrollieren. Gemessen 2026-08-16 am Claude-Broker, gleiches Token,
// einzige Differenz der Header: ohne ihn 11 待办 / 21 正在进行 / 31 完成, mit ihm
// 11 To Do / 21 In Progress / 31 Done bei unveraenderten IDs. Der Token-Request
// und tenant_info laufen ohne Token und brauchen ihn nicht.
function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["Accept-Language"] = "en-US";
  }
  return headers;
}

function bodyOptions(method: string, value?: unknown, token?: string): RequestOptions {
  const headers = authHeaders(token);
  if (value === undefined) return { method, headers };
  const body = Buffer.from(JSON.stringify(value), "utf8");
  headers["Content-Type"] = "application/json";
  headers["Content-Length"] = String(body.length);
  return { method, headers, body };
}

// OP-1396. An upload cannot go through bodyOptions, which stringifies its value
// and hard-sets application/json. It must not acquire its own token and cloudId
// either: a second auth path is a second identity, and separate credential
// variables per runtime only mean something while there is exactly one. So it
// borrows the same session and contributes only the body and the headers that
// describe it - the multipart content type and the XSRF header from
// jira-attach.mts.
function uploadOptions(token: string, request: UploadRequest): RequestOptions {
  return { method: "POST", headers: { ...authHeaders(token), ...request.headers }, body: request.body };
}

async function requestJson(deps: BrokerDeps, url: string, options: RequestOptions): Promise<JsonResponse> {
  let response: HttpResponse;
  try {
    response = await deps.fetch(url, options);
  } catch {
    return { status: 0, json: { error: "network_error" } };
  }
  const text = await response.text();
  let json: JiraPayload = {};
  try {
    json = text ? JSON.parse(text) as JiraPayload : {};
  } catch {
    // Nur gefilterte Felder verlassen das Script.
  }
  return { status: response.status, json };
}

// OP-1396. The byte read, on the same authenticated session as everything else:
// it takes the session it is given rather than acquiring one. `Accept` is
// widened because the answer is a file, and asking for application/json here
// would describe the request wrongly. The spec pins this response to 200 as long
// as the caller sent redirect=false, so anything else is handed back unread.
async function requestBytes(
  deps: BrokerDeps,
  activeSession: Session,
  path: string,
): Promise<{ status: number; bytes?: Buffer; error?: string }> {
  let response: HttpResponse;
  try {
    response = await deps.fetch(`${activeSession.base}${path}`, {
      method: "GET",
      headers: { ...authHeaders(activeSession.token), Accept: "*/*" },
    });
  } catch {
    return { status: 0, error: "network_error" };
  }
  if (response.status !== 200) return { status: response.status };
  if (typeof response.arrayBuffer !== "function") {
    return { status: response.status, error: "Die Antwort liefert keinen Bytestrom." };
  }
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

function errorFields(json: JiraPayload = {}): ErrorFields {
  const result: ErrorFields = {};
  if (typeof json.error === "string") result.error = json.error;
  if (typeof json.error_description === "string") result.errorDescription = json.error_description;
  if (Array.isArray(json.errorMessages)) result.errorMessages = json.errorMessages.map(String);
  if (json.errors && typeof json.errors === "object" && !Array.isArray(json.errors)) {
    result.errors = Object.fromEntries(Object.entries(json.errors).map(([key, value]) => [key, String(value)]));
  }
  return result;
}

function failedResponse(status: number, json: JiraPayload, fallback: string, extra: CliOutput = {}): CliOutput {
  const filtered = errorFields(json);
  return { status, ...extra, ...filtered, ...(filtered.error ? {} : { error: fallback }) };
}

async function credentials(deps: BrokerDeps): Promise<AtlassianCredentials> {
  const credentialPath = productEnv(deps.env, "ATL_CRED_FILE_CODEX");
  if (!credentialPath) stop("KHEREP_ATL_CRED_FILE_CODEX ist nicht gesetzt.");
  let raw: string;
  try {
    raw = await deps.readFile(credentialPath, "utf8");
  } catch {
    stop("Credentials-Datei ist nicht lesbar.");
  }
  return parseCredentialText(raw);
}

async function requestToken(deps: BrokerDeps, values: { clientId: string; clientSecret: string }): Promise<JsonResponse> {
  return requestJson(deps, AUTH_URL, bodyOptions("POST", {
    grant_type: "client_credentials",
    client_id: values.clientId,
    client_secret: values.clientSecret,
    audience: "api.atlassian.com",
  }));
}

function tamperSecret(secret: string): string {
  if (secret.length < 4) stop("Client Secret ist zu kurz für den Kontroll-Lauf.");
  const suffix = [...secret.slice(-4)].map((character) => (character === "X" ? "Y" : "X")).join("");
  return `${secret.slice(0, -4)}${suffix}`;
}

function tokenStep(response: JsonResponse): TokenStep {
  return {
    status: response.status,
    ...errorFields(response.json),
    tokenLength: typeof response.json.access_token === "string" ? response.json.access_token.length : 0,
  };
}

async function tenantInfo(deps: BrokerDeps): Promise<JsonResponse> {
  return requestJson(deps, `${deps.seed!.site}/_edge/tenant_info`, bodyOptions("GET"));
}

function plainStep(response: JsonResponse): CliOutput {
  return { status: response.status, ...errorFields(response.json) };
}

interface Session {
  token: string;
  base: string;
}

async function session(deps: BrokerDeps): Promise<Session> {
  const tokenResponse = await requestToken(deps, await credentials(deps));
  const token = tokenResponse.json.access_token;
  if (tokenResponse.status !== 200 || typeof token !== "string" || !token) {
    throw new CliFailure(failedResponse(tokenResponse.status, tokenResponse.json, "Token-Request fehlgeschlagen."));
  }
  const tenant = await tenantInfo(deps);
  const cloudId = tenant.json.cloudId;
  if (tenant.status !== 200 || typeof cloudId !== "string" || !cloudId) {
    throw new CliFailure(failedResponse(tenant.status, tenant.json, "tenant_info fehlgeschlagen."));
  }
  return { token, base: `${API_ROOT}/${encodeURIComponent(cloudId)}/rest/api/3` };
}

// A host that names only its site and project key gets the rest from the site.
// This costs one extra token request, and only on hosts that did not pin the
// discoverable half; a fully configured host never reaches it.
async function resolveBinding(deps: BrokerDeps): Promise<JiraBinding> {
  const activeSession = await session(deps);
  const discovered = await discoverProject(async (path) => {
    const response = await jira(deps, activeSession, "GET", path);
    if (response.status !== 200) {
      throw new CliFailure(failedResponse(response.status, response.json, "Projektauflösung fehlgeschlagen."));
    }
    return response.json;
  }, deps.seed!.projectKey);
  return bindingFromSeed(deps.seed!, discovered);
}

async function jira(
  deps: BrokerDeps,
  activeSession: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  return requestJson(deps, `${activeSession.base}${path}`, bodyOptions(method, body, activeSession.token));
}

function identity(json: JiraPayload | undefined, location: "self" | "creator" | "author"): Identity {
  let source: UserLike | undefined = json;
  if (location === "creator") {
    source = json?.fields?.creator;
  } else if (location === "author") {
    source = json?.author;
  }

  if (!source) return {};
  return { accountType: source.accountType, displayName: source.displayName };
}

type Options = Record<string, string | undefined>;

function parseOptions(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value: string | undefined = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) stop("CLI-Argumente sind unvollständig.");
    const name = flag.slice(2);
    if (options[name] !== undefined) stop("Ein CLI-Argument wurde mehrfach angegeben.");
    options[name] = value;
  }
  return options;
}

function rejectUnknownOptions(options: Options, allowed: string[]): void {
  if (Object.keys(options).some((name) => !allowed.includes(name))) {
    stop("Unbekanntes CLI-Argument.");
  }
}

function requireText(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) stop(`--${name} fehlt.`);
  return value;
}

function requireKey(options: Options, projectKey: string): string {
  return requireIssueKey(requireText(options, "key"), projectKey, "--key");
}

function requireParent(options: Options, projectKey: string): string {
  return requireIssueKey(requireText(options, "parent"), projectKey, "--parent");
}

function requireIssueKey(value: string, projectKey: string, label: string): string {
  const key = value.trim().toUpperCase();
  if (!new RegExp(`^${projectKey}-\\d+$`).test(key)) {
    stop(`${label} gehört nicht zum konfigurierten Jira-Projekt.`);
  }
  return key;
}

async function selftest(deps: BrokerDeps): Promise<CliResult> {
  const values = await credentials(deps);
  const good = await requestToken(deps, values);
  const bad = await requestToken(deps, { ...values, clientSecret: tamperSecret(values.clientSecret) });
  const tokenSummary = tokenStep(good);
  const controlSummary = tokenStep(bad);
  const output: CliOutput = { token: tokenSummary, control: controlSummary };
  const discriminates = good.status === 200 && tokenSummary.tokenLength > 0
    && bad.status === 401 && bad.json.error === "access_denied" && controlSummary.tokenLength === 0;
  if (!discriminates) {
    const same = good.status === bad.status && good.json.error === bad.json.error
      && Boolean(good.json.access_token) === Boolean(bad.json.access_token);
    return { exitCode: 1, output: { ...output, verdict: same ? "UNKNOWN" : "FAIL" } };
  }
  const tenant = await tenantInfo(deps);
  output.tenantInfo = plainStep(tenant);
  if (tenant.status !== 200 || typeof tenant.json.cloudId !== "string" || !tenant.json.cloudId) {
    return { exitCode: 1, output: { ...output, verdict: "FAIL" } };
  }
  const myself = await requestJson(
    deps,
    `${API_ROOT}/${encodeURIComponent(tenant.json.cloudId)}/rest/api/3/myself`,
    bodyOptions("GET", undefined, good.json.access_token),
  );
  const measured = identity(myself.json, "self");
  output.myself = { status: myself.status, ...errorFields(myself.json), ...measured };
  const pass = myself.status === 200 && measured.accountType === "app";
  return { exitCode: pass ? 0 : 1, output: { ...output, verdict: pass ? "PASS" : "FAIL" } };
}

async function create(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const config = deps.jira!;
  const type = options.type || "Task";
  if (!config.issueTypes[type]) stop(`Unbekannter --type. Erlaubt: ${Object.keys(config.issueTypes).join(", ")}.`);
  const assignee = parseAssignee(options.assignee);
  if (assignee?.error) stop(assignee.error);
  const fields: WriteFields = {
    project: { id: config.projectId },
    issuetype: { id: config.issueTypes[type] },
    summary: requireText(options, "summary"),
    description: toAdf(requireText(options, "body")),
    ...fieldEdits({ assignee }),
  };
  if (type !== "Sub-task" && options.parent !== undefined) stop("--parent ist nur für Sub-task erlaubt.");
  const parent = type === "Sub-task" ? requireParent(options, config.projectKey) : null;
  if (parent) fields.parent = { key: parent };
  const activeSession = await session(deps);
  const written = await jira(deps, activeSession, "POST", "/issue", { fields });
  const issueKey = written.json.key;
  if (written.status !== 201 || !issueKey || !new RegExp(`^${config.projectKey}-\\d+$`).test(issueKey)) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Create fehlgeschlagen.") };
  }
  // Ein 201 sagt, dass der Vorgang existiert, nicht dass die Zuweisung sitzt und
  // nicht, dass der Sub-task am gewünschten Elternvorgang hängt (golden rule 13).
  // Gelesen werden nur die Felder, die dieser Aufruf gesetzt hat.
  const columns = ["creator"];
  if (parent) columns.push("parent");
  if (assignee) columns.push("assignee");
  const readback = await jira(deps, activeSession, "GET", `/issue/${issueKey}?fields=${columns.join(",")}`);
  const measured = identity(readback.json, "creator");
  const output: CliOutput = { status: written.status, issueKey, readbackStatus: readback.status, ...measured };
  const readParent = readback.json?.fields?.parent?.key;
  const parentMismatch = parent !== null && readParent !== parent
    ? `Readback bestätigt den Elternvorgang nicht: erwartet ${parent}, gelesen ${readParent ?? "keinen"}.`
    : null;
  const mismatch = verifyReadback({ assignee }, readback.json?.fields) ?? parentMismatch;
  const pass = readback.status === 200 && readback.json.key === issueKey
    && measured.accountType === "app" && !mismatch;
  const proven: CliOutput = { ...output };
  if (parent) proven.parent = parent;
  if (assignee) proven.assignee = assignee.accountId;
  return pass
    ? { exitCode: 0, output: proven }
    : {
      exitCode: 1,
      output: {
        ...output,
        ...errorFields(readback.json),
        error: mismatch || "Create-Readback hat keinen App-Creator bestätigt.",
      },
    };
}

// Bearbeiten. Nur die uebergebenen Felder werden gesetzt; ein nicht genanntes
// Feld bleibt unangetastet, damit ein Aufruf nicht still eine Beschreibung leert.
// --labels, --components und --assignee gehorchen derselben Regel: ohne den
// Schalter bleibt das Feld stehen, mit leerem Wert wird es geleert. Bei
// --assignee heisst leeren, dass der Vorgang niemandem mehr zugewiesen ist.
// --assignee nimmt eine accountId, keinen Anzeigenamen (OP-1049).
async function update(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const issueKey = requireKey(options, deps.jira!.projectKey);
  const plan: FieldPlan = {
    labels: parseFieldList(options.labels),
    componentIds: null,
    assignee: parseAssignee(options.assignee),
  };
  if (plan.assignee?.error) stop(plan.assignee.error);
  const componentNames = parseFieldList(options.components);
  const fields: WriteFields = {};
  if (options.summary) fields.summary = options.summary;
  if (options.body) fields.description = toAdf(options.body);
  if (Object.keys(fields).length === 0 && !plan.labels && !componentNames && !plan.assignee) {
    stop("Nichts zu ändern: --summary, --body, --labels, --components und/oder --assignee angeben.");
  }
  const activeSession = await session(deps);
  // Namen werden VOR dem Schreiben aufgelöst. Ein unbekannter Name bricht hier
  // ab, damit nicht die übrigen Felder geschrieben sind, während Jira den Aufruf
  // wegen der Komponente mit einer 400 abweist.
  if (componentNames) {
    const catalog = await jira(deps, activeSession, "GET", componentCatalogPath(deps.jira!.projectId));
    if (catalog.status !== 200) {
      return { exitCode: 1, output: failedResponse(catalog.status, catalog.json, "Komponenten des Projekts sind nicht lesbar.", { issueKey }) };
    }
    const resolved = resolveComponentNames(componentNames, catalog.json);
    if (resolved.error) return { exitCode: 1, output: { status: catalog.status, issueKey, error: resolved.error } };
    plan.componentIds = resolved.ids;
  }
  Object.assign(fields, fieldEdits(plan));
  const written = await jira(deps, activeSession, "PUT", `/issue/${issueKey}`, { fields });
  if (written.status !== 204) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Update fehlgeschlagen.", { issueKey }) };
  }
  // Zurückgelesen und verglichen: eine 204 sagt nur, dass der Aufruf angenommen
  // wurde, und ist damit kein Messwert.
  const readback = await jira(deps, activeSession, "GET", `/issue/${issueKey}?fields=${readbackColumns(plan)}`);
  const output: CliOutput = { status: written.status, issueKey, readbackStatus: readback.status };
  if (readback.status !== 200) {
    return { exitCode: 1, output: { ...output, ...errorFields(readback.json), error: "Readback nach dem Update fehlgeschlagen." } };
  }
  if (fields.summary !== undefined && readback.json?.fields?.summary !== fields.summary) {
    return { exitCode: 1, output: { ...output, error: "Readback bestätigt die neue Summary nicht." } };
  }
  const mismatch = verifyReadback(plan, readback.json?.fields);
  if (mismatch) return { exitCode: 1, output: { ...output, error: mismatch } };
  return { exitCode: 0, output };
}

async function comment(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const issueKey = requireKey(options, deps.jira!.projectKey);
  const body = requireText(options, "body");
  const activeSession = await session(deps);
  const written = await jira(deps, activeSession, "POST", `/issue/${issueKey}/comment`, {
    body: toAdf(body),
  });
  if (written.status < 200 || written.status >= 300 || !written.json.id) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Comment fehlgeschlagen.", { issueKey }) };
  }
  const commentId = String(written.json.id);
  const readback = await jira(
    deps, activeSession, "GET", `/issue/${issueKey}/comment/${encodeURIComponent(commentId)}`,
  );
  const measured = identity(readback.json, "author");
  const output: CliOutput = { status: written.status, issueKey, readbackStatus: readback.status, ...measured };
  const pass = readback.status === 200 && String(readback.json.id) === commentId && measured.accountType === "app";
  return pass
    ? { exitCode: 0, output }
    : { exitCode: 1, output: { ...output, ...errorFields(readback.json), error: "Comment-Readback hat keinen App-Autor bestätigt." } };
}

// OP-1396. Anhang hochladen. Nutzt dieselbe session() wie jeder andere Verb:
// gleicher Token, gleiche cloudId, gleicher Sprach-Header.
//
// EINE Datei pro Aufruf. Jira nimmt laut Doku bis zu 60 Teile in einer Anfrage,
// aber parseOptions weist ein wiederholtes Flag absichtlich ab, und diese
// Schranke fuer eine Bequemlichkeit aufzuweichen, nach der niemand gefragt hat,
// waere der falsche Tausch.
async function attach(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const issueKey = requireKey(options, deps.jira!.projectKey);
  const filePath = requireText(options, "file");
  const contentType = partContentType(options["content-type"]);
  if (contentType.error || !contentType.value) stop(contentType.error ?? "Medientyp fehlt.");
  let bytes: Buffer;
  try {
    bytes = await deps.readBytes(filePath);
  } catch {
    stop("--file ist nicht lesbar."); // bewusst ohne Pfad in der Meldung
  }
  const upload = uploadRequest(filePath, contentType.value, bytes);
  if (upload.error || !upload.request) stop(upload.error ?? "Upload-Body ist unvollständig.");

  const activeSession = await session(deps);
  const written = await requestJson(
    deps,
    `${activeSession.base}${attachmentPath(issueKey)}`,
    uploadOptions(activeSession.token, upload.request),
  );
  // Die Doku nennt 200, nicht 201. Ein 201 waere hier also KEIN Erfolg, sondern
  // eine Antwort, die wir nicht erklaeren koennen.
  if (written.status !== 200) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Attach fehlgeschlagen.", { issueKey }) };
  }
  const read = readAttachments(written.json);
  if (read.error || !read.attachments) {
    return { exitCode: 1, output: { status: written.status, issueKey, error: read.error ?? "Upload-Antwort ist unvollständig." } };
  }
  // Unabhaengig nachgemessen: die Upload-Antwort ist eine Meldung ueber sich
  // selbst (golden rule 13). Gelesen wird der Vorgang.
  const readback = await jira(deps, activeSession, "GET", `/issue/${issueKey}?fields=attachment`);
  const output: CliOutput = {
    status: written.status,
    issueKey,
    attachments: read.attachments,
    readbackStatus: readback.status,
  };
  if (readback.status !== 200) {
    return { exitCode: 1, output: { ...output, ...errorFields(readback.json), error: "Readback nach dem Upload fehlgeschlagen." } };
  }
  const confirmed = confirmAttachments(readback.json?.fields, read.attachments);
  return confirmed.error
    ? { exitCode: 1, output: { ...output, error: confirmed.error } }
    : { exitCode: 0, output };
}

// OP-1396. The readback the brokers were missing. Two requests: the metadata
// decides whether the bytes may be printed, then the content endpoint delivers
// them. Both go through session()/requestJson - the download does not
// authenticate itself, it reuses the one token and cloudId like every verb.
async function download(options: Options, deps: BrokerDeps): Promise<CliResult> {
  // --key binds here exactly as it binds in attach. It used to be rejected by
  // this broker's option allowlist alone - protection by accident, while the
  // other broker returned a foreign work item's attachment with exit 0.
  const issueKey = requireKey(options, deps.jira!.projectKey);
  const id = requireText(options, "id").trim();
  const activeSession = await session(deps);
  const listed = await jira(deps, activeSession, "GET", attachmentListPath(issueKey));
  if (listed.status !== 200) {
    return {
      exitCode: 1,
      output: failedResponse(listed.status, listed.json, "Anhangsliste nicht lesbar.", { issueKey, attachmentId: id }),
    };
  }
  const list = readAttachmentList(listed.json.fields);
  const read = selectAttachment(list.entries, id, issueKey);
  if (read.error || !read.meta) {
    return {
      exitCode: 1,
      output: { status: listed.status, issueKey, attachmentId: id, error: read.error ?? "Anhang nicht am Vorgang gefunden." },
    };
  }
  const meta = read.meta;
  // Decided BEFORE the content request. A caller who has to accept the type
  // learns that without the site first shipping bytes nobody may use.
  const decision = decideOutput(meta, options.accept, deps.stdoutIsTty());
  if (decision.error || !decision.print) {
    return { exitCode: 1, output: { status: listed.status, issueKey, attachmentId: id, mimeType: meta.mimeType, error: decision.error ?? "Kein Ausgabeziel." } };
  }
  const content = await requestBytes(deps, activeSession, attachmentContentPath(id));
  if (content.error || !content.bytes) {
    return {
      exitCode: 1,
      output: { status: content.status, attachmentId: id, error: content.error ?? "Download fehlgeschlagen." },
    };
  }
  // Golden rule 13: the status code is not the measurement, the byte count is.
  const complete = verifyDownload(content.bytes, meta);
  if (complete.error) {
    return { exitCode: 1, output: { status: content.status, attachmentId: id, error: complete.error } };
  }
  return {
    exitCode: 0,
    output: {
      status: content.status,
      attachmentId: meta.id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      bytes: content.bytes.length,
    },
    stdoutBytes: content.bytes,
  };
}

async function get(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const issueKey = requireKey(options, deps.jira!.projectKey);
  const activeSession = await session(deps);
  // OP-1372. The field set was fixed at creator, so the broker could confirm who
  // wrote an item but never report what it says.
  const fields = fieldListOr(options.fields, DEFAULT_ISSUE_FIELDS);
  const response = await jira(deps, activeSession, "GET", `/issue/${issueKey}?fields=${fields.join(",")}`);
  if (response.status !== 200) {
    return { exitCode: 1, output: failedResponse(response.status, response.json, "Get fehlgeschlagen.", { issueKey }) };
  }
  const values = response.json.fields;
  // OP-1396. The files hanging off the work item, and the ids `download` takes.
  // A work item without attachments carries no key at all: an empty array would
  // be a heading every caller has to learn to ignore.
  const attachments = readAttachmentList(values);
  return {
    exitCode: 0,
    output: {
      status: response.status,
      issueKey: response.json.key,
      ...(values?.summary === undefined ? {} : { summary: values.summary }),
      ...(values?.status?.name === undefined ? {} : { state: values.status.name }),
      ...describe(values?.description),
      ...identity(response.json, "creator"),
      ...(attachments.entries.length === 0 ? {} : { attachments: attachments.entries }),
      ...(attachments.error === undefined ? {} : { attachmentsError: attachments.error }),
    },
  };
}

// OP-1387. Die Beschreibung, als Text. Ein Vorgang ohne Body traegt das Feld
// gar nicht bei; eine vorhandene Beschreibung, die zu nichts rendert, ist genau
// der Fehler aus OP-1387 in neuer Gestalt und wird als solcher gemeldet statt
// still wegzufallen.
function describe(value: unknown): CliOutput {
  if (value === undefined || value === null) return {};
  const body = adfToText(value);
  return { description: body || DESCRIPTION_UNREADABLE };
}

// OP-1372. The duplicate check the house rules demand before creating a work item
// is only possible with a search that runs under the service account.
async function search(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const jql = (options.jql ?? "").trim();
  if (!jql) stop("--jql fehlt.");
  const activeSession = await session(deps);
  const path = searchPath({
    jql,
    maxResults: boundedMaxResults(options.max),
    fields: searchFields(options.fields),
    nextPageToken: options.page,
  });
  const response = await jira(deps, activeSession, "GET", path);
  if (response.status !== 200) {
    return { exitCode: 1, output: failedResponse(response.status, response.json, "Suche fehlgeschlagen.") };
  }
  const page = readPage(response.json);
  return {
    exitCode: 0,
    output: {
      status: response.status,
      count: page.hits.length,
      // The token is the only reliable end marker, so it travels with the result:
      // a caller that stops without checking it has read one page, not all.
      last: page.isLast,
      nextPageToken: page.nextPageToken,
      issues: page.hits,
      ...(page.warnings.length === 0 ? {} : { warnings: page.warnings }),
    },
  };
}

async function transition(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const issueKey = requireKey(options, deps.jira!.projectKey);
  const checked = validateTransitionIntent(options);
  if (checked.error || !checked.intent) stop(checked.error ?? "Transition-Intent ist unvollständig.");
  const { intent } = checked;

  const activeSession = await session(deps);
  const available = await jira(deps, activeSession, "GET", `/issue/${issueKey}/transitions`);
  if (available.status !== 200) {
    return { exitCode: 1, output: failedResponse(available.status, available.json, "Transitions konnten nicht gelesen werden.", { issueKey }) };
  }

  const { selected, ambiguous } = selectTransitionByCategory(available.json.transitions, intent.category);
  if (ambiguous) {
    return {
      exitCode: 1,
      output: {
        status: available.status,
        issueKey,
        error: "Statuskategorie trifft mehrere Übergänge.",
        candidates: ambiguous.map((candidate) => ({
          id: String(candidate.id),
          statusName: candidate.to?.name,
        })),
      },
    };
  }
  if (!selected?.id) {
    return {
      exitCode: 1,
      output: {
        status: available.status,
        issueKey,
        error: "Zielstatus ist nicht verfügbar.",
        availableStatusNames: (available.json.transitions || [])
          .map(({ name }) => name)
          .filter((name) => typeof name === "string"),
      },
    };
  }
  const targetStatusId = selected.to?.id;
  if (targetStatusId === undefined) {
    return {
      exitCode: 1,
      output: {
        status: available.status,
        issueKey,
        error: "Zielstatus mit verifizierbarer Status-ID ist nicht verfügbar.",
      },
    };
  }

  const body: { transition: { id: string }; update?: unknown } = { transition: { id: String(selected.id) } };
  if (intent.category === "done") {
    body.update = {
      comment: [{ add: { body: toAdf(doneAuditText(intent.acceptance)) } }],
    };
  }
  const written = await jira(deps, activeSession, "POST", `/issue/${issueKey}/transitions`, body);
  if (written.status !== 204) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Transition fehlgeschlagen.", { issueKey }) };
  }

  const readback = await jira(deps, activeSession, "GET", `/issue/${issueKey}?fields=status`);
  const reached = readback.json?.fields?.status;
  const output: CliOutput = {
    status: written.status,
    issueKey,
    readbackStatus: readback.status,
    statusId: reached?.id,
    statusName: reached?.name,
  };
  const pass = readback.status === 200
    && String(reached?.id) === String(targetStatusId);
  return pass
    ? { exitCode: 0, output }
    : { exitCode: 1, output: { ...output, ...errorFields(readback.json), error: "Transition-Readback bestätigt die Zielstatus-ID nicht." } };
}

interface LinkContext {
  activeSession: Session;
  plan: LinkPlan;
  type: LinkType;
}

async function linkContext(options: Options, deps: BrokerDeps): Promise<LinkContext> {
  const parsed = parseLinkOptions(options);
  if (parsed.error || !parsed.plan) stop(parsed.error ?? "Verknüpfungsdaten sind unvollständig.");
  parsed.plan.outwardKey = requireIssueKey(parsed.plan.outwardKey, deps.jira!.projectKey, "--outward");
  parsed.plan.inwardKey = requireIssueKey(parsed.plan.inwardKey, deps.jira!.projectKey, "--inward");
  const activeSession = await session(deps);
  const catalog = await jira(deps, activeSession, "GET", LINK_TYPE_CATALOG_PATH);
  if (catalog.status !== 200) {
    throw new CliFailure(failedResponse(catalog.status, catalog.json, "Verknüpfungstypen der Site sind nicht lesbar."));
  }
  const resolved = resolveLinkType(parsed.plan.typeName, catalog.json);
  if (resolved.error || !resolved.type) stop(resolved.error ?? "Verknüpfungstyp ist unvollständig.", catalog.status);
  return { activeSession, plan: parsed.plan, type: resolved.type };
}

async function link(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const { activeSession, plan, type } = await linkContext(options, deps);
  const written = await jira(deps, activeSession, "POST", LINK_PATH, linkRequestBody(type, plan));
  const description = describeLink(type, plan);
  if (written.status !== 201) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Link fehlgeschlagen.", { link: description }) };
  }
  const readback = await jira(deps, activeSession, "GET", linkReadbackPath(plan.outwardKey));
  const output: CliOutput = { status: written.status, link: description, readbackStatus: readback.status };
  if (readback.status !== 200) {
    return { exitCode: 1, output: { ...output, ...errorFields(readback.json), error: "Readback nach dem Verknüpfen fehlgeschlagen." } };
  }
  const confirmed = confirmLinkCreated(readback.json?.fields, type, plan);
  return confirmed.error
    ? { exitCode: 1, output: { ...output, error: confirmed.error } }
    : { exitCode: 0, output: { ...output, linkId: confirmed.id } };
}

async function unlink(options: Options, deps: BrokerDeps): Promise<CliResult> {
  const { activeSession, plan, type } = await linkContext(options, deps);
  const description = describeLink(type, plan);
  const existing = await jira(deps, activeSession, "GET", linkReadbackPath(plan.outwardKey));
  if (existing.status !== 200) {
    return { exitCode: 1, output: failedResponse(existing.status, existing.json, "Verknüpfungen des Vorgangs sind nicht lesbar.", { link: description }) };
  }
  const chosen = selectLinkToRemove(existing.json?.fields, type, plan);
  if (chosen.error || !chosen.id) {
    return { exitCode: 1, output: { status: existing.status, link: description, error: chosen.error ?? "Link-ID fehlt." } };
  }
  const written = await jira(deps, activeSession, "DELETE", linkDeletePath(chosen.id));
  if (written.status !== 200 && written.status !== 204) {
    return { exitCode: 1, output: failedResponse(written.status, written.json, "Unlink fehlgeschlagen.", { link: description, linkId: chosen.id }) };
  }
  const readback = await jira(deps, activeSession, "GET", linkReadbackPath(plan.outwardKey));
  const output: CliOutput = { status: written.status, link: description, linkId: chosen.id, readbackStatus: readback.status };
  if (readback.status !== 200) {
    return { exitCode: 1, output: { ...output, ...errorFields(readback.json), error: "Readback nach dem Lösen fehlgeschlagen." } };
  }
  const removed = confirmLinkRemoved(readback.json?.fields, type, plan);
  return removed.error
    ? { exitCode: 1, output: { ...output, error: removed.error } }
    : { exitCode: 0, output };
}

// OP-1124: one table instead of an allow-list plus an if-chain. The two used to
// be kept in step by hand, and a command present in one and missing in the other
// would have fallen through runCli without a result.
interface Command {
  allowed: string[];
  run: (options: Options, deps: BrokerDeps) => Promise<CliResult>;
}

const COMMANDS: Record<string, Command> = {
  create: { allowed: ["type", "summary", "body", "parent", "assignee"], run: create },
  update: { allowed: ["key", "summary", "body", "labels", "components", "assignee"], run: update },
  comment: { allowed: ["key", "body"], run: comment },
  attach: { allowed: ["key", "file", "content-type"], run: attach },
  download: { allowed: ["key", "id", "accept"], run: download },
  get: { allowed: ["key", "fields"], run: get },
  search: { allowed: ["jql", "max", "fields", "page"], run: search },
  transition: { allowed: ["key", "to", "acceptance"], run: transition },
  link: { allowed: ["type", "outward", "inward"], run: link },
  unlink: { allowed: ["type", "outward", "inward"], run: unlink },
};

export async function runCli(argv: string[], injected: Partial<BrokerDeps> = {}): Promise<CliResult> {
  const deps: BrokerDeps = {
    env: injected.env ?? process.env,
    readFile: injected.readFile ?? nodeReadFile,
    readBytes: injected.readBytes ?? ((path) => nodeReadFile(path)),
    fetch: injected.fetch ?? globalThis.fetch,
    stdoutIsTty: injected.stdoutIsTty ?? (() => Boolean(process.stdout.isTTY)),
  };
  try {
    const [name, ...rest] = argv;
    if (name === "selftest" && rest.length === 0) {
      // selftest needs the site it should prove itself against, and nothing
      // else. Validating it here keeps the contract that a misconfigured host
      // fails on configuration, before any credential read or network call.
      deps.seed = jiraSeed(deps.env);
      return await selftest(deps);
    }
    const command = COMMANDS[name];
    if (!command) stop("Nutzung: create | update | comment | attach | download | get | search | transition | link | unlink | selftest.");
    const options = parseOptions(rest);
    rejectUnknownOptions(options, command.allowed);
    deps.seed = jiraSeed(deps.env);
    deps.jira = configuredBinding(deps.env) ?? await resolveBinding(deps);
    return await command.run(options, deps);
  } catch (error) {
    let output: CliOutput;
    if (error instanceof CliFailure) {
      output = error.output;
    } else if (error instanceof AtlassianCredentialError || error instanceof JiraConfigError) {
      output = { status: 0, error: error.message };
    } else {
      output = { status: 0, error: "Interner Fehler." };
    }
    return {
      exitCode: 1,
      output,
    };
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = await runCli(process.argv.slice(2));
  // With attachment bytes in hand stdout belongs to them alone, so the envelope
  // moves to stderr. That is not a claim that anything went wrong: it is the
  // channel that is not the payload.
  if (result.stdoutBytes) {
    process.stdout.write(result.stdoutBytes);
    process.stderr.write(`${JSON.stringify(result.output)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
  }
  process.exitCode = result.exitCode;
}
