// OP-1396: reading an attachment back out of Jira, shared by both brokers.
//
// WHY THIS EXISTS. jira-attach.mts owns the write side and is already at the
// 250-LOC limit from CLAUDE.md rule 6, and reading back is a different decision
// set: where to send the bytes, and whether they arrived whole. Same contract as
// its sibling - everything here is pure, the caller owns the HTTP and the file
// system - so every branch is reachable from a test without a network.
//
// WHY IT EXISTS AT ALL: both brokers could upload and neither could read back,
// so acceptance had to go around the broker to see a file it had just written.
// A write-only tool is one that cannot check its own work (golden rule 13).
//
// THE SHAPE IS READ OFF THE SPEC, NOT REMEMBERED (CLAUDE.md rule 5). Jira Cloud
// v3 OpenAPI, pulled 2026-09-18 from
// developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json.
//
// `getAttachment`, GET /rest/api/3/attachment/{id}, verbatim:
//   "Returns the metadata for an attachment. Note that the attachment itself is
//    not returned."
// declaring x-atlassian-oauth2-scopes
//   [{"scheme":"OAuth2","scopes":["read:jira-work"],"state":"Current"}]
// and deprecated:false. 200 is "Returned if the request is successful."
//
// `getAttachmentContent`, GET /rest/api/3/attachment/content/{id}, verbatim:
//   "Returns the contents of an attachment. A `Range` header can be set to
//    define a range of bytes within the attachment to download."
// same Current scope ["read:jira-work"], deprecated:false. Its two success codes
// are NOT interchangeable, and this is the whole reason for CONTENT_QUERY below:
//   200: "Returned if the request is successful when `redirect` is set to
//        `false`."
//   303: "Returned if the request is successful. See the `Location` header for
//        the download URL."
// and the `redirect` query parameter, which defaults to true, is documented as
//   "Whether a redirect is provided for the attachment download. Clients that do
//    not automatically follow redirects can set this to `false` to avoid making
//    multiple requests to download the attachment."
//
// So the broker sets it to false and expects the documented 200. That is one
// request instead of two, it never hands the Authorization header to whatever
// host the Location pointed at, and - decisive here - it does not depend on the
// injected FetchLike implementing redirect following, which a test stub cannot
// do. A 303 reaching this code means the parameter did not take effect, and is
// reported rather than guessed at.

// The path segment, named so the contract test and the brokers refer to the
// same string as the comment above.
const CONTENT_QUERY = "redirect=false";

/**
 * The work item's own attachment list, which is where a download starts.
 *
 * WHY NOT GET /rest/api/3/attachment/{id}. Live acceptance found that `download
 * --key OP-1396 --id 10222` returned the attachment of a DIFFERENT work item
 * with exit 0, because --key was accepted and never read: a typo produced a
 * confident wrong answer. The obvious cross-check is impossible from the
 * metadata endpoint, because `AttachmentMetadata` carries no issue reference of
 * any kind - not the key, not an id, nothing (verified against the v3 OpenAPI,
 * 2026-09-18).
 *
 * Reading the issue's attachment field instead answers BOTH questions at once:
 * whether the attachment really hangs off the named work item, and what its
 * stored filename, mimeType and size are. The documented `Attachment` schema in
 * that field carries id, filename, mimeType and size, which is everything the
 * printable rule and the byte check need. So this REPLACES the metadata call
 * rather than adding one - the request count is unchanged - and a key naming a
 * work item that does not exist now fails as a 404 instead of silently handing
 * over somebody else's file.
 */
export function attachmentListPath(issueKey: string): string {
  return `/issue/${encodeURIComponent(issueKey)}?fields=attachment`;
}

export function attachmentContentPath(id: string): string {
  return `/attachment/content/${encodeURIComponent(id)}?${CONTENT_QUERY}`;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface AttachmentMetaResult {
  meta?: AttachmentMeta;
  error?: string;
}

/**
 * The metadata, read rather than assumed. `mimeType` and `size` are required
 * here even though the schema would let them be absent: both are load-bearing
 * downstream - one decides where the bytes go, the other is the only
 * independent check that they all arrived - and a default for either would be
 * this module inventing the fact it exists to read.
 */
export function readAttachmentMeta(value: unknown): AttachmentMetaResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Die Anhang-Metadaten sind kein lesbares Objekt." };
  }
  const { id, filename, mimeType, size } = value as Record<string, unknown>;
  if ((typeof id !== "string" && typeof id !== "number") || String(id) === "") {
    return { error: "Die Anhang-Metadaten haben keine ID." };
  }
  if (typeof filename !== "string" || !filename) {
    return { error: "Die Anhang-Metadaten haben keinen Dateinamen." };
  }
  if (typeof mimeType !== "string" || !mimeType.trim()) {
    return { error: "Die Anhang-Metadaten nennen keinen Medientyp." };
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    return { error: "Die Anhang-Metadaten nennen keine lesbare Groesse." };
  }
  return { meta: { id: String(id), filename, mimeType, size } };
}

// One normalisation for every media type here: "text/markdown; charset=utf-8" is the type "text/markdown".
function baseMediaType(raw: string | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

// RFC 6838 section 4.2.8 structured syntax suffixes. A type nobody enumerated -
// application/vnd.example+json - is still JSON, and an allowlist of exact names
// would have to grow every time somebody invents a vendor type.
const TEXT_SUFFIXES = ["+json", "+xml", "+yaml"];

// The textual types that live under application/ without a suffix to say so.
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

/**
 * THE PRINTABLE RULE, and the one input it is allowed to read.
 *
 * The decision is made from the mimeType the SITE STORED, never from the
 * Content-Type of the download response. Measured against the live instance on
 * 2026-09-18: Jira answers the content endpoint with `Content-Type: text/plain`
 * even for an attachment it stored as `application/octet-stream`. A broker that
 * believed the response header would therefore print arbitrary bytes at a
 * terminal, which is the exact thing this rule exists to prevent.
 *
 * Printable means: the whole `text/` tree, plus structured text that happens to
 * be filed under `application/`. Everything else - including
 * `application/octet-stream`, which means "unknown bytes" by definition - is
 * opaque and needs a file to go to. Opaque is the default: a type this function
 * has never heard of is not printed.
 */
export function isPrintableMediaType(raw: string): boolean {
  const type = baseMediaType(raw);
  if (!type) return false;
  if (type.startsWith("text/")) return true;
  if (TEXT_APPLICATION_TYPES.has(type)) return true;
  return TEXT_SUFFIXES.some((suffix) => type.endsWith(suffix));
}

export interface OutputDecision {
  print?: true;
  error?: string;
}

/**
 * WHY THERE IS NO --out. The obvious design - the broker writes the bytes to a
 * path the caller names - cannot exist in these brokers. The Claude broker is
 * held by a static assertion that it imports NO write API at all, so that a
 * token can never be persisted: a token file would sit outside the
 * privacy-boundary-guard, which covers only the credentials path, and stay valid
 * for up to an hour. An attachment sink is a convenience; that is a security
 * invariant, and the convenience does not get to win. Moving the write into this
 * module instead would satisfy the letter of that assertion while destroying its
 * point, which is precisely the "do not edit around the guard" case.
 *
 * So the broker writes to stdout and the shell provides the path. Decided with
 * the director on 2026-09-18 (OP-1396).
 *
 * THE RULE, and the one input it reads: the mimeType the SITE STORED.
 *
 *   printable type                    -> bytes to stdout
 *   opaque type, not accepted         -> refused, and the message says how
 *   opaque type, accepted, stdout tty -> refused: that is the spray we prevent
 *   opaque type, accepted, redirected -> bytes to stdout
 *
 * WHY AN OPAQUE TYPE IS REACHABLE AT ALL. Because refusing it outright would
 * make the broker unable to read back files IT ITSELF WROTE: attach stores
 * `application/octet-stream` whenever the caller names no --content-type, and
 * attachment 10223 is exactly that - Markdown the site has filed as opaque
 * bytes. A readback that cannot read our own default upload would recreate the
 * detour this work item exists to remove.
 *
 * WHY THE OPT-IN NAMES THE TYPE instead of being a bare --force. The caller has
 * to have looked at the stored type to pass it, which means they looked at what
 * they are about to print, and the accepted value is visible in the command
 * line afterwards. A bare flag would be typed once out of habit and never
 * thought about again.
 *
 * The tty check is the last gate and the literal hazard: bytes of unknown shape
 * reaching a terminal can carry control and escape sequences. Redirected, they
 * cannot reach one.
 */
export function decideOutput(
  meta: AttachmentMeta,
  accept: string | undefined,
  stdoutIsTty: boolean,
): OutputDecision {
  if (isPrintableMediaType(meta.mimeType)) return { print: true };
  const accepted = baseMediaType(accept);
  const stored = baseMediaType(meta.mimeType);
  if (accepted !== stored) {
    return {
      error: `Der Anhang ist als ${meta.mimeType} gespeichert und geht nicht ungefragt nach stdout. `
        + `Erneut aufrufen mit --accept ${meta.mimeType} und stdout in eine Datei umleiten.`,
    };
  }
  if (stdoutIsTty) {
    return {
      error: `stdout ist ein Terminal. ${meta.mimeType} wuerde dort als Steuerzeichen landen: `
        + "in eine Datei umleiten.",
    };
  }
  return { print: true };
}

/**
 * The independent measurement. A 200 says the request was answered, not that the
 * file arrived whole (golden rule 13), and a truncated download that nobody
 * compared is indistinguishable from a short file.
 */
export function verifyDownload(bytes: Buffer, meta: AttachmentMeta): { error?: string } {
  return bytes.length === meta.size
    ? {}
    : { error: `Der Anhang kam unvollstaendig an: ${bytes.length} statt ${meta.size} Byte.` };
}

export interface AttachmentListResult {
  entries: AttachmentMeta[];
  error?: string;
}

/**
 * The `attachment` field of a work item, for `get`. An issue without attachments
 * and an issue whose attachments were not requested both yield an empty list and
 * print nothing: there is no heading to leave empty.
 *
 * An entry that is present but unreadable is a different thing from an absent
 * one, so the reason travels back with the entries that did read (rule 12)
 * rather than leaving the list merely looking short.
 */
export function readAttachmentList(fields: unknown): AttachmentListResult {
  const listed = (fields as { attachment?: unknown } | null | undefined)?.attachment;
  if (!Array.isArray(listed)) return { entries: [] };
  const entries: AttachmentMeta[] = [];
  let unreadable = 0;
  for (const entry of listed) {
    const { meta } = readAttachmentMeta(entry);
    if (meta) entries.push(meta);
    else unreadable += 1;
  }
  return unreadable === 0
    ? { entries }
    : { entries, error: `${unreadable} Anhang/Anhaenge am Vorgang sind nicht lesbar.` };
}

/**
 * The attachment the caller asked for, taken from the list of the work item they
 * named. This is the whole cross-check: an id that is not on that list does not
 * belong to that work item, and the command stops instead of fetching it.
 *
 * The refusal names BOTH values, because the reported failure was a typo in one
 * of them and a message naming only one leaves the caller guessing which. The
 * ids that ARE on the work item follow, since with them the typo is usually
 * visible at a glance.
 *
 * WHY NOT confirmAttachments FROM jira-attach.mts, which reads the same field:
 * it is cut for the upload readback and too narrow here on three counts. It
 * takes `Attachment[]` carrying a filename, which is one of the things download
 * is still trying to learn; it answers only `{ error? }`, so the found entry -
 * and with it the mimeType the printable rule needs - cannot come back out; and
 * its message names neither the work item nor the available ids. Widening it
 * would bend the upload's readback around a reader's needs.
 */
export function selectAttachment(entries: AttachmentMeta[], id: string, issueKey: string): AttachmentMetaResult {
  const found = entries.find((entry) => entry.id === id);
  if (found) return { meta: found };
  const available = entries.length === 0
    ? "Der Vorgang hat keine Anhaenge."
    : `Am Vorgang haengen: ${entries.map((entry) => entry.id).join(", ")}.`;
  return { error: `Anhang ${id} haengt nicht an ${issueKey}. ${available}` };
}

/**
 * One attachment, one line, in the order the site returned them. The id comes
 * first because it is the one column the caller feeds back into `download`.
 */
export function formatAttachmentLine({ id, filename, mimeType, size }: AttachmentMeta): string {
  return `${id} ${filename} ${mimeType} ${size}`;
}
