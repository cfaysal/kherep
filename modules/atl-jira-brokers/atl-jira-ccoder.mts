#!/usr/bin/env node
// Public Jira broker. Credential values are read only through KHEREP_ATL_CRED_FILE_CLAUDE.
// Paths, credentials, and access tokens must never be printed.
import { readFile as nodeReadFile } from "node:fs/promises";
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
} from "./jira-attach.mts";
import {
  attachmentContentPath,
  attachmentListPath,
  decideOutput,
  formatAttachmentLine,
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

const CRED_ENV = "KHEREP_ATL_CRED_FILE_CLAUDE";
function productEnv(env: Record<string, string | undefined>, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}
const AUTH_URL = "https://auth.atlassian.com/oauth/token";

// OP-1124. The injected surface is declared structurally rather than as node's
// fetch and readFile: the tests hand over stubs answering exactly these members,
// and a wider type would force every stub to build a whole Response object.
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
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
// OP-1396. Injected for the same reason as ReadBytesLike: a test must be able to
// see the bytes that would have reached a terminal without any reaching one, and
// must be able to say whether stdout IS a terminal without owning the process.
export type WriteOutLike = (chunk: Buffer) => void;

// Token und cloudId eines Laufs. Siehe accessToken: die Bindung an den ctx ist
// das, was den Cache sicher macht.
export interface SessionCache {
  token?: string;
  tokenExpiresAt?: number;
  cloudId?: string;
}

export interface BrokerContext {
  env: Record<string, string | undefined>;
  readFile: ReadFileLike;
  readBytes: ReadBytesLike;
  // THE DOWNLOAD CONTRACT: stdout carries attachment bytes and nothing else, so
  // `download | ...` in an agent's hands is the file and not the file plus a
  // status line. Every human-readable line the command emits therefore goes to
  // stderr, which is not a claim that anything went wrong - it is the channel
  // that is not the payload.
  writeOut: WriteOutLike;
  // Whether stdout is a terminal. The last gate before opaque bytes are printed.
  stdoutIsTty: () => boolean;
  fetch: FetchLike;
  log: (line: string) => void;
  logError: (line: string) => void;
  now: () => number;
  session: SessionCache;
  seed?: JiraSeed;
  jira?: JiraBinding;
}

interface UserLike {
  accountType?: string;
  displayName?: string;
}

interface StatusLike {
  id?: string | number;
  name?: string;
}

// What this broker reads out of a Jira JSON response. A payload that does not
// carry a field leaves it undefined; nothing here is proven by the type.
export interface JiraJson {
  key?: string;
  id?: string | number;
  errorMessages?: unknown[];
  errors?: Record<string, unknown>;
  transitions?: TransitionCandidate[];
  fields?: IssueFields & { summary?: unknown; creator?: UserLike; status?: StatusLike; issuelinks?: unknown; parent?: { key?: string } };
}

interface TokenPayload {
  access_token?: string;
  error?: string;
  expires_in?: number;
}

interface TokenResult {
  status: number;
  token: string | null;
  error: string | null;
  expiresIn: number | null;
}

interface JiraResponse {
  status: number;
  json: JiraJson | null;
}

export type Args = Record<string, string | undefined>;

// Abbruch wirft, statt den Prozess zu beenden. process.exit mitten im Modul
// haette jeden Fehlerpfad untestbar gemacht: der Testrunner waere mitgestorben.
// Der Prozess-Exitcode wird ausschliesslich an der CLI-Grenze unten gesetzt.
class CliFailure extends Error {
  cliMessage: string;

  constructor(message: string) {
    super(message);
    this.cliMessage = message;
  }
}

// Declared `never`: every caller below relies on this not returning, and saying
// so is what lets the checks read as guards instead of needing a second branch.
function fail(message: string): never {
  throw new CliFailure(message);
}

async function readCredentials(ctx: BrokerContext): Promise<AtlassianCredentials> {
  const path = productEnv(ctx.env, "ATL_CRED_FILE_CLAUDE");
  if (!path) fail(`${CRED_ENV} ist nicht gesetzt.`);
  let raw: string;
  try {
    raw = await ctx.readFile(path, "utf8");
  } catch {
    fail("Credentials-Datei nicht lesbar."); // bewusst ohne Pfad in der Meldung
  }
  return parseCredentialText(raw);
}

async function requestToken(
  ctx: BrokerContext,
  { clientId, clientSecret }: { clientId: string; clientSecret: string },
): Promise<TokenResult> {
  const response = await ctx.fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: Buffer.from(JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: "api.atlassian.com",
    }), "utf8"),
  });
  const payload = await response.json().catch(() => ({})) as TokenPayload;
  return {
    status: response.status,
    token: payload.access_token || null,
    error: payload.error || null,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : null,
  };
}

// Token und cloudId gelten fuer die Dauer EINES Laufs. Der Cache haengt am ctx,
// das runCli pro Aufruf neu baut - niemals am Modul. Ein modulglobaler Cache
// wuerde die Fehlerklasse wieder oeffnen, die die getrennten Credential-
// Variablen gerade verhindern sollen: ein zweiter Lauf im selben Prozess wuerde
// still den Token des ersten weiterverwenden und unter fremder Identitaet
// schreiben, und die Vorgaenge saehen dabei voellig korrekt aus.
// Es wird nichts auf Platte geschrieben. Ein Token-Cache als Datei waere ein
// neues Geheimnis an einem Pfad, den der privacy-boundary-guard nicht deckt.
// Zuvor authentifizierte jeder einzelne Jira-Aufruf neu: ein transition kostete
// drei Token- und drei tenant_info-Requests. Der Codex-Broker holt seine Session
// seit jeher einmal pro Kommando; das hier ist die Herstellung der Paritaet.
const TOKEN_SAFETY_MS = 60_000;

async function accessToken(ctx: BrokerContext): Promise<string> {
  // Beide Felder werden nur gemeinsam gesetzt; die Pruefung auf beide macht das
  // fuer den Typ sichtbar, ohne die Bedingung zu veraendern.
  const { token: cached, tokenExpiresAt } = ctx.session;
  if (cached && tokenExpiresAt !== undefined && tokenExpiresAt > ctx.now() + TOKEN_SAFETY_MS) {
    return cached;
  }
  const { status, token, error, expiresIn } = await requestToken(ctx, await readCredentials(ctx));
  if (!token) fail(`Token-Request fehlgeschlagen: HTTP ${status}${error ? ` ${error}` : ""}`);
  // Ohne belastbares expires_in wird NICHT zwischengespeichert. Lieber ein
  // Request mehr als ein abgelaufener Token in einem langlebigen Prozess -
  // runCli ist seit OP-817 importierbar und kann wiederholt aufgerufen werden.
  if (expiresIn !== null && expiresIn > 0) {
    ctx.session.token = token;
    ctx.session.tokenExpiresAt = ctx.now() + expiresIn * 1000;
  }
  return token;
}

// A host that names only its site and project key gets the rest from the site.
// One run resolves once; the result lives in the same per-run session cache as
// the token, so a second command in the same process performs no extra call.
async function resolveBinding(ctx: BrokerContext): Promise<JiraBinding> {
  const discovered = await discoverProject(async (path) => {
    const { status, json } = await jira(ctx, "GET", path);
    if (status !== 200) fail(`Projektauflösung fehlgeschlagen: HTTP ${status}`);
    return json;
  }, ctx.seed!.projectKey);
  return bindingFromSeed(ctx.seed!, discovered);
}

// cloudId ist kein Geheimnis: tenant_info wird ohne Header aufgerufen.
async function cloudId(ctx: BrokerContext): Promise<string> {
  if (ctx.session.cloudId) return ctx.session.cloudId;
  const response = await ctx.fetch(`${ctx.seed!.site}/_edge/tenant_info`);
  if (!response.ok) fail(`tenant_info fehlgeschlagen: HTTP ${response.status}`);
  const { cloudId: id } = await response.json() as { cloudId?: string };
  if (!id) fail("tenant_info lieferte keine cloudId.");
  ctx.session.cloudId = id;
  return id;
}

// UTF-8-Bytes explizit: bei Default-Kodierung kippen Umlaute in der ADF-Nutzlast.
// Accept-Language explizit: ohne diesen Header traegt die Anfrage gar keine
// Sprachpraeferenz - node fetch setzt von sich aus keine - und Jira liefert
// Status- und Transition-Namen in einer Sprache, die wir nicht kontrollieren.
// Gemessen 2026-08-16 ohne Header: 11 待办 / 21 正在进行 / 31 完成 bei
// unveraenderten IDs. Die Regeltexte in CLAUDE.md setzen englische Bezeichner
// voraus, also fordern wir sie an.
//
// OP-1396: send() is the ONE authenticated path. An upload cannot go through
// jira() below, which stringifies its body and hard-sets application/json, but
// it must not acquire its own token and cloudId either - a second auth path is a
// second identity, and separate credential variables per runtime only mean
// something while there is exactly one. A caller therefore hands over a prepared
// payload (body plus the headers that describe it) and everything about who is
// calling stays here.
interface RequestPayload {
  body: Buffer;
  headers: Record<string, string>;
}

// The payload is parsed here rather than by each caller: both of them did it,
// and only the type they expect differs. `unknown` is what the wire actually
// carries - an object for every verb below, an array for an upload - so the two
// callers narrow it themselves instead of sharing a lie.
// OP-1396. The one place a request learns who is calling. Extracted so the
// attachment download can reuse it verbatim instead of acquiring a token and a
// cloudId of its own: the download is a third body shape, not a third identity.
async function authorized(
  ctx: BrokerContext,
  path: string,
  extra?: Record<string, string>,
): Promise<{ url: string; headers: Record<string, string> }> {
  const token = await accessToken(ctx);
  return {
    url: `https://api.atlassian.com/ex/jira/${await cloudId(ctx)}/rest/api/3${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      ...extra,
    },
  };
}

async function send(
  ctx: BrokerContext,
  method: string,
  path: string,
  payload?: RequestPayload,
): Promise<{ status: number; json: unknown }> {
  const { url, headers } = await authorized(ctx, path, payload?.headers);
  const response = await ctx.fetch(url, { method, headers, body: payload?.body });
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 204 und Fehlerseiten */ }
  return { status: response.status, json };
}

// The byte read, on the same authenticated path as everything else. `Accept` is
// widened because the answer is a file: asking for application/json here would
// describe the request wrongly. The spec pins this response to 200 as long as
// the caller sent redirect=false, so anything else is handed back unread.
async function sendBytes(
  ctx: BrokerContext,
  path: string,
): Promise<{ status: number; bytes?: Buffer; error?: string }> {
  const { url, headers } = await authorized(ctx, path, { Accept: "*/*" });
  const response = await ctx.fetch(url, { method: "GET", headers });
  if (response.status !== 200) return { status: response.status };
  if (typeof response.arrayBuffer !== "function") {
    return { status: response.status, error: "Die Antwort liefert keinen Bytestrom." };
  }
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function jira(ctx: BrokerContext, method: string, path: string, body?: unknown): Promise<JiraResponse> {
  let payload: RequestPayload | undefined;
  if (body !== undefined) {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    payload = {
      body: encoded,
      headers: { "Content-Type": "application/json", "Content-Length": String(encoded.length) },
    };
  }
  const { status, json } = await send(ctx, method, path, payload);
  return { status, json: json as JiraJson | null };
}

// API v3 nimmt kein Plaintext. OP-928: der Body geht durch den gemeinsamen
// Block-Renderer, damit eine Ueberschrift, eine Liste oder ein Code-Block als
// solche im Vorgang ankommen statt als ein durchlaufender Absatz. Der Name
// bleibt fuer die Aufrufer stehen.
export const adf = renderAdf;
export const selectTransition = selectTransitionByCategory;

async function bodyOf(ctx: BrokerContext, args: Args): Promise<string | undefined> {
  if (args["body-file"]) {
    try {
      return await ctx.readFile(args["body-file"], "utf8");
    } catch {
      fail("--body-file nicht lesbar.");
    }
  }
  return args.body;
}

function reportErrors(ctx: BrokerContext, json: JiraJson | null): void {
  if (!json) return;
  for (const message of Array.isArray(json.errorMessages) ? json.errorMessages : []) {
    ctx.logError(`errorMessage: ${message}`);
  }
  for (const [field, message] of Object.entries(json.errors || {})) {
    ctx.logError(`error ${field}: ${message}`);
  }
}

// The write body of a create or update: the shared field edits plus whatever the
// command adds on top (project, issuetype, summary, description).
type WriteFields = Record<string, unknown>;

// OP-1124: ein Sub-task ohne Elternvorgang ist kein Sub-task. Der Schlüssel
// wird deshalb vor jedem Netzaufruf geprüft, nicht erst an Jiras 400.
function requireParent(args: Args, projectKey: string): string {
  const parent = (args.parent ?? "").trim().toUpperCase();
  if (!parent) fail("--parent fehlt.");
  return requireIssueKey(parent, projectKey, "--parent");
}

function requireIssueKey(value: string, projectKey: string, label: string): string {
  const key = value.trim().toUpperCase();
  if (!new RegExp(`^${projectKey}-\\d+$`).test(key)) {
    fail(`${label} gehört nicht zum konfigurierten Jira-Projekt.`);
  }
  return key;
}

function commandKey(ctx: BrokerContext, args: Args): string {
  if (!args.key) fail("--key fehlt.");
  return requireIssueKey(args.key, ctx.jira!.projectKey, "--key");
}

async function cmdCreate(ctx: BrokerContext, args: Args): Promise<number> {
  const config = ctx.jira!;
  const typeId = config.issueTypes[args.type || "Task"];
  if (!typeId) fail(`Unbekannter --type. Erlaubt: ${Object.keys(config.issueTypes).join(", ")}`);
  if (!args.summary) fail("--summary fehlt.");
  const assignee = parseAssignee(args.assignee);
  if (assignee?.error) fail(assignee.error);
  if (args.type !== "Sub-task" && args.parent !== undefined) fail("--parent ist nur für Sub-task erlaubt.");
  const parent = args.type === "Sub-task" ? requireParent(args, config.projectKey) : null;
  const fields: WriteFields = {
    project: { id: config.projectId },
    issuetype: { id: typeId },
    summary: args.summary,
    description: adf(await bodyOf(ctx, args)),
    ...fieldEdits({ assignee }),
  };
  if (parent) fields.parent = { key: parent };
  const { status, json } = await jira(ctx, "POST", "/issue", { fields });
  ctx.log(`status: ${status}`);
  if (json?.key) ctx.log(`key: ${json.key}`);
  reportErrors(ctx, json);
  if (status !== 201) return 1;
  if (!json?.key || !new RegExp(`^${config.projectKey}-\\d+$`).test(json.key)) {
    ctx.logError("Create lieferte keinen Vorgang im konfigurierten Jira-Projekt.");
    return 1;
  }
  // Ein 201 sagt, dass der Vorgang existiert, nicht dass die Zuweisung sitzt und
  // nicht, dass der Sub-task am gewünschten Elternvorgang hängt (golden rule
  // 13). Gelesen werden nur die Felder, die dieser Aufruf gesetzt hat.
  const columns: string[] = [];
  if (parent) columns.push("parent");
  if (assignee) columns.push("assignee");
  if (columns.length === 0) return 0;
  const after = await jira(ctx, "GET", `/issue/${json?.key}?fields=${columns.join(",")}`);
  if (after.status !== 200) {
    ctx.logError("Readback nach dem Create fehlgeschlagen.");
    return 1;
  }
  const mismatch = verifyReadback({ assignee }, after.json?.fields);
  if (mismatch) {
    ctx.logError(mismatch);
    return 1;
  }
  if (parent) {
    const read = after.json?.fields?.parent?.key;
    if (read !== parent) {
      ctx.logError(`Readback bestätigt den Elternvorgang nicht: erwartet ${parent}, gelesen ${read ?? "keinen"}.`);
      return 1;
    }
    ctx.log(`parent danach: ${parent}`);
  }
  if (assignee) ctx.log(`assignee danach: ${assignee.accountId ?? "niemand"}`);
  return 0;
}

// Bearbeiten. Nur die uebergebenen Felder werden gesetzt; ein nicht genanntes
// Feld bleibt unangetastet, damit ein Aufruf nicht still eine Beschreibung leert.
// --labels, --components und --assignee gehorchen derselben Regel: ohne den
// Schalter bleibt das Feld stehen, mit leerem Wert wird es geleert. Bei
// --assignee heisst leeren, dass der Vorgang niemandem mehr zugewiesen ist.
// --assignee nimmt eine accountId, keinen Anzeigenamen (OP-1049).
async function cmdUpdate(ctx: BrokerContext, args: Args): Promise<number> {
  const issueKey = commandKey(ctx, args);
  const body = await bodyOf(ctx, args);
  const plan: FieldPlan = { labels: parseFieldList(args.labels), componentIds: null, assignee: parseAssignee(args.assignee) };
  if (plan.assignee?.error) fail(plan.assignee.error);
  const componentNames = parseFieldList(args.components);
  const fields: WriteFields = {};
  if (args.summary) fields.summary = args.summary;
  if (body) fields.description = adf(body);
  if (Object.keys(fields).length === 0 && !plan.labels && !componentNames && !plan.assignee) {
    fail("Nichts zu aendern: --summary, --body/--body-file, --labels, --components und/oder --assignee angeben.");
  }
  // Namen werden VOR dem Schreiben aufgeloest. Ein unbekannter Name bricht hier
  // ab, damit nicht die uebrigen Felder geschrieben sind, waehrend Jira den
  // Aufruf wegen der Komponente mit einer 400 abweist.
  if (componentNames) {
    const catalog = await jira(ctx, "GET", componentCatalogPath(ctx.jira!.projectId));
    if (catalog.status !== 200) {
      ctx.log(`status: ${catalog.status}`);
      reportErrors(ctx, catalog.json);
      ctx.logError("Komponenten des Projekts sind nicht lesbar.");
      return 1;
    }
    const resolved = resolveComponentNames(componentNames, catalog.json);
    if (resolved.error) fail(resolved.error);
    plan.componentIds = resolved.ids;
  }
  Object.assign(fields, fieldEdits(plan));
  const { status, json } = await jira(ctx, "PUT", `/issue/${issueKey}`, { fields });
  ctx.log(`status: ${status}`);
  reportErrors(ctx, json);
  if (status !== 204) return 1;
  // Zurueckgelesen: eine 204 sagt nur, dass der Aufruf angenommen wurde.
  const after = await jira(ctx, "GET", `/issue/${issueKey}?fields=${readbackColumns(plan)}`);
  const summaryAfter = after.json?.fields?.summary;
  ctx.log(`summary danach: ${summaryAfter ?? "unlesbar"}`);
  if (after.status !== 200) {
    ctx.logError("Readback nach dem Update fehlgeschlagen.");
    return 1;
  }
  // Verglichen, nicht nur gedruckt. Ein gedruckter Readback, den niemand
  // prueft, sieht bei einem falschen Ergebnis genauso aus wie bei einem
  // richtigen. Summary, Labels und Komponenten sind exakt vergleichbar; nur
  // eine Beschreibung kommt als ADF zurueck, das Jira normalisieren darf.
  if (fields.summary !== undefined && summaryAfter !== fields.summary) {
    ctx.logError("Readback bestaetigt die neue Summary nicht.");
    return 1;
  }
  const mismatch = verifyReadback(plan, after.json?.fields);
  if (mismatch) {
    ctx.logError(mismatch);
    return 1;
  }
  if (fields.description !== undefined) {
    ctx.log("hinweis: Beschreibung wurde geschrieben, aber nicht durch Vergleich bestaetigt.");
  }
  return 0;
}

async function cmdComment(ctx: BrokerContext, args: Args): Promise<number> {
  const issueKey = commandKey(ctx, args);
  const body = await bodyOf(ctx, args);
  if (!body) fail("--body oder --body-file fehlt.");
  const { status, json } = await jira(ctx, "POST", `/issue/${issueKey}/comment`, { body: adf(body) });
  ctx.log(`status: ${status}`);
  if (json?.id) ctx.log(`commentId: ${json.id}`);
  reportErrors(ctx, json);
  return status === 201 ? 0 : 1;
}

// OP-1396. Anhang hochladen. Laeuft ueber dieselbe send()-Funktion wie jeder
// andere Verb: gleicher Token, gleiche cloudId, gleicher Sprach-Header. Neu sind
// nur der multipart-Body und der XSRF-Header, beide in jira-attach.mts gebaut.
//
// EINE Datei pro Aufruf. Jira nimmt laut Doku bis zu 60 Teile in einer Anfrage,
// aber beide Broker lesen ein Flag genau einmal - der Codex-Broker weist ein
// wiederholtes Flag absichtlich ab - und diese Schranke fuer eine Bequemlichkeit
// aufzuweichen, nach der niemand gefragt hat, waere der falsche Tausch.
async function cmdAttach(ctx: BrokerContext, args: Args): Promise<number> {
  const issueKey = commandKey(ctx, args);
  if (!args.file?.trim()) fail("--file fehlt.");
  const contentType = partContentType(args["content-type"]);
  if (contentType.error || !contentType.value) fail(contentType.error ?? "Medientyp fehlt.");
  let bytes: Buffer;
  try {
    bytes = await ctx.readBytes(args.file);
  } catch {
    fail("--file nicht lesbar."); // bewusst ohne Pfad in der Meldung
  }
  const upload = uploadRequest(args.file, contentType.value, bytes);
  if (upload.error || !upload.request) fail(upload.error ?? "Upload-Body ist unvollstaendig.");

  const { status, json } = await send(ctx, "POST", attachmentPath(issueKey), upload.request);
  ctx.log(`status: ${status}`);
  // Der Erfolgsfall ist eine Liste, der Fehlerfall ein Objekt mit errorMessages.
  reportErrors(ctx, json && !Array.isArray(json) ? json as JiraJson : null);
  // Die Doku nennt 200, nicht 201. Ein 201 waere hier also KEIN Erfolg, sondern
  // eine Antwort, die wir nicht erklaeren koennen.
  if (status !== 200) return 1;
  const read = readAttachments(json);
  if (read.error || !read.attachments) {
    ctx.logError(read.error ?? "Upload-Antwort ist unvollstaendig.");
    return 1;
  }
  for (const { id, filename } of read.attachments) {
    ctx.log(`attachmentId: ${id}`);
    ctx.log(`filename: ${filename}`);
  }
  // Unabhaengig nachgemessen: die Upload-Antwort ist eine Meldung ueber sich
  // selbst (golden rule 13). Gelesen wird der Vorgang.
  const after = await jira(ctx, "GET", `/issue/${issueKey}?fields=attachment`);
  if (after.status !== 200) {
    ctx.logError("Readback nach dem Upload fehlgeschlagen.");
    return 1;
  }
  const confirmed = confirmAttachments(after.json?.fields, read.attachments);
  if (confirmed.error) {
    ctx.logError(confirmed.error);
    return 1;
  }
  return 0;
}

// Unabhaengiges Zuruecklesen: die Antwort eines Schreibvorgangs ist eine Meldung
// ueber sich selbst und kein Messwert.
async function cmdGet(ctx: BrokerContext, args: Args): Promise<number> {
  const issueKey = commandKey(ctx, args);
  // OP-1372. The field set was fixed at summary,creator and the summary was
  // fetched but never printed, so a caller could read neither the title nor the
  // status without a second tool.
  const fields = fieldListOr(args.fields, DEFAULT_ISSUE_FIELDS);
  const { status, json } = await jira(ctx, "GET", `/issue/${issueKey}?fields=${fields.join(",")}`);
  ctx.log(`status: ${status}`);
  if (json?.key) ctx.log(`key: ${json.key}`);
  if (json?.fields?.summary) ctx.log(`summary: ${String(json.fields.summary)}`);
  if (json?.fields?.status?.name) ctx.log(`state: ${json.fields.status.name}`);
  // OP-1387. Die Beschreibung, als Text. Auf einer eigenen Zeile und dann roh,
  // weil ein Fliesstext nicht in ein "key: value"-Paar passt.
  const description = json?.fields?.description;
  if (description !== undefined && description !== null) {
    const body = adfToText(description);
    // Eine vorhandene Beschreibung, die zu nichts rendert, ist genau der Fehler
    // aus OP-1387 in neuer Gestalt. Sie wird gemeldet statt still wegzufallen.
    ctx.log(body ? `description:\n${body}` : `description: ${DESCRIPTION_UNREADABLE}`);
  }
  const creator = json?.fields?.creator;
  if (creator) {
    ctx.log(`creator.accountType: ${creator.accountType}`);
    ctx.log(`creator.displayName: ${creator.displayName}`);
  }
  // OP-1396. The files hanging off the work item, and the ids `download` takes.
  // A work item without attachments prints nothing at all: an empty heading is
  // noise that every caller would have to learn to ignore.
  const attachments = readAttachmentList(json?.fields);
  for (const entry of attachments.entries) ctx.log(`attachment: ${formatAttachmentLine(entry)}`);
  if (attachments.error) ctx.logError(attachments.error);
  reportErrors(ctx, json);
  return status === 200 ? 0 : 1;
}

// OP-1396. The readback the brokers were missing. Two requests: the metadata
// decides where the bytes may go, then the content endpoint delivers them.
//
// Both go through jira()/sendBytes() and therefore through the single token and
// cloudId acquisition - the download does not authenticate itself.
async function cmdDownload(ctx: BrokerContext, args: Args): Promise<number> {
  // --key binds here exactly as it binds in attach. It used to be accepted and
  // never read, so a typo returned a foreign work item's attachment with exit 0.
  const issueKey = commandKey(ctx, args);
  const id = args.id?.trim();
  if (!id) fail("--id fehlt.");
  const listed = await jira(ctx, "GET", attachmentListPath(issueKey));
  if (listed.status !== 200) {
    ctx.logError(`status: ${listed.status}`);
    reportErrors(ctx, listed.json);
    return 1;
  }
  const list = readAttachmentList(listed.json?.fields);
  if (list.error) ctx.logError(list.error);
  const read = selectAttachment(list.entries, id, issueKey);
  if (read.error || !read.meta) {
    ctx.logError(read.error ?? "Anhang nicht am Vorgang gefunden.");
    return 1;
  }
  const meta = read.meta;
  // Decided BEFORE the content request. A caller who has to accept the type
  // learns that without the site first shipping bytes nobody may use.
  const decision = decideOutput(meta, args.accept, ctx.stdoutIsTty());
  if (decision.error || !decision.print) {
    ctx.logError(decision.error ?? "Kein Ausgabeziel.");
    return 1;
  }
  const content = await sendBytes(ctx, attachmentContentPath(id));
  if (content.error || !content.bytes) {
    ctx.logError(content.error ?? `Download fehlgeschlagen: HTTP ${content.status}`);
    return 1;
  }
  // Golden rule 13: the status code is not the measurement, the byte count is.
  const complete = verifyDownload(content.bytes, meta);
  if (complete.error) {
    ctx.logError(complete.error);
    return 1;
  }
  ctx.writeOut(content.bytes);
  return 0;
}

// Statuswechsel. Gehoert hierher und nicht in einen MCP-Aufruf: der Zweck des
// Service Accounts ist, dass Claudes Fussabdruck in Jira nicht das persoenliche
// Konto des Directors ist. Ein Statuswechsel ist genau so ein Fussabdruck.
async function cmdTransition(ctx: BrokerContext, args: Args): Promise<number> {
  const issueKey = commandKey(ctx, args);
  const checked = validateTransitionIntent(args);
  if (checked.error || !checked.intent) fail(checked.error ?? "Transition-Intent ist unvollstaendig.");
  const { intent } = checked;

  const listing = await jira(ctx, "GET", `/issue/${issueKey}/transitions`);
  if (listing.status !== 200) {
    ctx.log(`status: ${listing.status}`);
    reportErrors(ctx, listing.json);
    return 1;
  }
  const available = listing.json?.transitions || [];
  const { selected: wanted, ambiguous } = selectTransitionByCategory(available, intent.category);
  if (ambiguous) {
    const candidates = ambiguous.map((t) => `${t.id} ${t.to?.name ?? "?"}`).join(", ");
    fail(`Kategorie "${intent.category}" trifft mehrere Uebergaenge: ${candidates}. Workflow pruefen.`);
  }
  if (!wanted?.id) fail(`Statuskategorie "${intent.category}" nicht verfuegbar.`);
  const expectedId = wanted.to?.id;
  if (expectedId === undefined) fail("Zielstatus hat keine verifizierbare Status-ID.");

  const body: { transition: { id: string }; update?: unknown } = { transition: { id: String(wanted.id) } };
  if (intent.category === "done") {
    body.update = {
      comment: [{ add: { body: adf(doneAuditText(intent.acceptance)) } }],
    };
  }
  const { status, json } = await jira(ctx, "POST", `/issue/${issueKey}/transitions`, body);
  ctx.log(`status: ${status}`);
  reportErrors(ctx, json);
  if (status !== 204) return 1;
  // Zurueckgelesen, weil eine 204 nur besagt, dass der Aufruf angenommen wurde.
  const after = await jira(ctx, "GET", `/issue/${issueKey}?fields=status`);
  const reached = after.json?.fields?.status;
  ctx.log(`status danach: ${reached?.name ?? "unlesbar"}`);
  if (after.status !== 200) {
    ctx.logError("Readback nach dem Statuswechsel fehlgeschlagen.");
    return 1;
  }
  // Verglichen ueber die Status-ID, nicht ueber den Namen: die ID ist exakt und
  // sprachunabhaengig. Vorher wurde der Readback nur gedruckt - ein Wechsel auf
  // ein falsches Ziel haette wie ein Erfolg ausgesehen.
  if (String(reached?.id) !== String(expectedId)) {
    ctx.logError(`Readback bestaetigt den Zielstatus nicht: erwartet Status-ID ${expectedId}, gelesen ${reached?.id ?? "keine"}.`);
    return 1;
  }
  return 0;
}

async function linkContext(ctx: BrokerContext, args: Args): Promise<{ plan: LinkPlan; type: LinkType }> {
  const parsed = parseLinkOptions(args);
  if (parsed.error || !parsed.plan) fail(parsed.error ?? "Verknüpfungsdaten sind unvollständig.");
  parsed.plan.outwardKey = requireIssueKey(parsed.plan.outwardKey, ctx.jira!.projectKey, "--outward");
  parsed.plan.inwardKey = requireIssueKey(parsed.plan.inwardKey, ctx.jira!.projectKey, "--inward");
  const catalog = await jira(ctx, "GET", LINK_TYPE_CATALOG_PATH);
  if (catalog.status !== 200) {
    ctx.log(`status: ${catalog.status}`);
    reportErrors(ctx, catalog.json);
    fail("Verknüpfungstypen der Site sind nicht lesbar.");
  }
  const resolved = resolveLinkType(parsed.plan.typeName, catalog.json);
  if (resolved.error || !resolved.type) fail(resolved.error ?? "Verknüpfungstyp ist unvollständig.");
  return { plan: parsed.plan, type: resolved.type };
}

async function cmdLink(ctx: BrokerContext, args: Args): Promise<number> {
  const { plan, type } = await linkContext(ctx, args);
  const { status, json } = await jira(ctx, "POST", LINK_PATH, linkRequestBody(type, plan));
  ctx.log(`status: ${status}`);
  ctx.log(`verknüpfung: ${describeLink(type, plan)}`);
  reportErrors(ctx, json);
  if (status !== 201) return 1;
  const after = await jira(ctx, "GET", linkReadbackPath(plan.outwardKey));
  if (after.status !== 200) {
    ctx.logError("Readback nach dem Verknüpfen fehlgeschlagen.");
    return 1;
  }
  const confirmed = confirmLinkCreated(after.json?.fields, type, plan);
  if (confirmed.error || !confirmed.id) {
    ctx.logError(confirmed.error ?? "Link-ID fehlt.");
    return 1;
  }
  ctx.log(`linkId: ${confirmed.id}`);
  return 0;
}

async function cmdUnlink(ctx: BrokerContext, args: Args): Promise<number> {
  const { plan, type } = await linkContext(ctx, args);
  const before = await jira(ctx, "GET", linkReadbackPath(plan.outwardKey));
  if (before.status !== 200) {
    ctx.log(`status: ${before.status}`);
    reportErrors(ctx, before.json);
    fail("Verknüpfungen des Vorgangs sind nicht lesbar.");
  }
  const chosen = selectLinkToRemove(before.json?.fields, type, plan);
  if (chosen.error || !chosen.id) fail(chosen.error ?? "Link-ID fehlt.");
  const { status, json } = await jira(ctx, "DELETE", linkDeletePath(chosen.id));
  ctx.log(`status: ${status}`);
  ctx.log(`verknüpfung: ${describeLink(type, plan)}`);
  ctx.log(`linkId: ${chosen.id}`);
  reportErrors(ctx, json);
  if (status !== 200 && status !== 204) return 1;
  const after = await jira(ctx, "GET", linkReadbackPath(plan.outwardKey));
  if (after.status !== 200) {
    ctx.logError("Readback nach dem Lösen fehlgeschlagen.");
    return 1;
  }
  const removed = confirmLinkRemoved(after.json?.fields, type, plan);
  if (removed.error) {
    ctx.logError(removed.error);
    return 1;
  }
  return 0;
}

// Kontroll-Lauf. Ein Test, der bei richtigen und falschen Zugangsdaten dasselbe
// liefert, diskriminiert nicht und beweist nichts. Die Verfaelschung passiert hier
// drin, damit das Secret den Prozess nicht verlaesst.
async function cmdSelftest(ctx: BrokerContext): Promise<number> {
  const credentials = await readCredentials(ctx);
  const good = await requestToken(ctx, credentials);
  ctx.log(`echt: status ${good.status}${good.error ? ` ${good.error}` : ""}, token ${good.token ? `laenge ${good.token.length}` : "keiner"}`);

  const bad = await requestToken(ctx, {
    clientId: credentials.clientId,
    clientSecret: `${credentials.clientSecret.slice(0, -4)}XXXX`,
  });
  ctx.log(`verfaelscht: status ${bad.status}${bad.error ? ` ${bad.error}` : ""}, token ${bad.token ? "ERHALTEN" : "keiner"}`);

  const discriminates = good.status === 200 && !!good.token && bad.status === 401 && !bad.token;
  // OP-1415. "Diskriminiert nicht" hat zwei sehr verschiedene Gruende, und nur
  // einer davon ist unentschieden. GLEICHE Antwort auf echtes und verfaelschtes
  // Secret heisst: der Test kann beide nicht auseinanderhalten und weiss nichts
  // - so sieht ein rotiertes oder widerrufenes Secret aus. VERSCHIEDENE Antwort
  // heisst: die Gegenstelle kann es sehr wohl, und abgelehnt hat sie das echte.
  // Das ist ein bewiesenes Nein und darf nicht als Nichtwissen gemeldet werden.
  // Exitcode unveraendert: 0 nur bei PASS, wie im Codex-Broker.
  const same = good.status === bad.status && good.error === bad.error
    && !!good.token === !!bad.token;
  ctx.log(`verdikt: ${discriminates ? "PASS"
    : same ? "UNBEKANNT - Test diskriminiert nicht"
      : "FEHLSCHLAG - echtes Secret abgelehnt"}`);
  return discriminates ? 0 : 1;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

// OP-1372. The duplicate check the house rules demand before creating a work
// item is only possible with a search that runs under the service account.
async function cmdSearch(ctx: BrokerContext, args: Args): Promise<number> {
  // Trimmed here, not only inside searchPath: a whitespace-only flag would reach
  // the module, throw a plain Error, and surface as "Interner Fehler." instead of
  // naming the argument the caller got wrong.
  if (!args.jql?.trim()) fail("--jql fehlt.");
  const path = searchPath({
    jql: args.jql,
    maxResults: boundedMaxResults(args.max),
    fields: searchFields(args.fields),
    nextPageToken: args.page,
  });
  const { status, json } = await jira(ctx, "GET", path);
  ctx.log(`status: ${status}`);
  if (status === 200) {
    const page = readPage(json);
    for (const hit of page.hits) ctx.log(`${hit.key}\t${hit.status}\t${hit.summary}`);
    ctx.log(`count: ${page.hits.length}`);
    // The token is the only reliable end marker, so it is reported rather than
    // hidden: a caller that stops without checking it has read one page, not all.
    ctx.log(`last: ${page.isLast}`);
    if (page.nextPageToken) ctx.log(`nextPageToken: ${page.nextPageToken}`);
    for (const warning of page.warnings) ctx.log(`warning: ${warning}`);
  }
  reportErrors(ctx, json);
  return status === 200 ? 0 : 1;
}

const COMMANDS: Record<string, (ctx: BrokerContext, args: Args) => Promise<number>> = {
  create: cmdCreate,
  update: cmdUpdate,
  comment: cmdComment,
  attach: cmdAttach,
  download: cmdDownload,
  get: cmdGet,
  search: cmdSearch,
  transition: cmdTransition,
  link: cmdLink,
  unlink: cmdUnlink,
  selftest: cmdSelftest,
};

export async function runCli(argv: string[], injected: Partial<BrokerContext> = {}): Promise<number> {
  const ctx: BrokerContext = {
    env: injected.env ?? process.env,
    readFile: injected.readFile ?? nodeReadFile,
    readBytes: injected.readBytes ?? ((path) => nodeReadFile(path)),
    writeOut: injected.writeOut ?? ((chunk) => { process.stdout.write(chunk); }),
    stdoutIsTty: injected.stdoutIsTty ?? (() => Boolean(process.stdout.isTTY)),
    fetch: injected.fetch ?? globalThis.fetch,
    log: injected.log ?? ((line) => console.log(line)),
    logError: injected.logError ?? ((line) => console.error(line)),
    now: injected.now ?? (() => Date.now()),
    // Frisch pro Lauf. Das ist die Bindung, die den Cache sicher macht.
    session: {},
  };
  const [command, ...rest] = argv;
  try {
    const run = COMMANDS[command];
    if (!run) fail("Nutzung: create | update | comment | attach | download | get | search | transition | link | unlink | selftest");
    // The seed is validated for every command, so a misconfigured host fails
    // on configuration before any credential read or network call.
    // selftest stops there: it proves the credential and must not depend on
    // a reachable project, or a broken credential would surface as a failed
    // project lookup.
    ctx.seed = jiraSeed(ctx.env);
    if (command !== "selftest") {
      ctx.jira = configuredBinding(ctx.env) ?? await resolveBinding(ctx);
    }
    return await run(ctx, parseArgs(rest));
  } catch (error) {
    let message: string;
    if (error instanceof CliFailure) {
      message = error.cliMessage;
    } else if (error instanceof AtlassianCredentialError || error instanceof JiraConfigError) {
      message = error.message;
    } else {
      message = "Interner Fehler.";
    }
    ctx.logError(message);
    return 1;
  }
}

// Nur bei direktem Aufruf ausfuehren. Ohne diese Schranke fuehrt jeder Import -
// und damit jeder Test - das Kommando aus.
if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
