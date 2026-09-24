// OP-1396: shared attachment-upload shape for both Jira brokers.
//
// WHY THIS EXISTS. The same reason jira-adf.mts and jira-fields.mts exist: both
// brokers already sit above the 250-LOC limit from CLAUDE.md, and two copies of
// a wire format drift apart by the second bug fix. Everything here is pure - the
// caller owns the HTTP and the file read, this module owns the bytes and the
// decisions - so every branch is reachable from a test without a network.
//
// WHY NOT FormData/Blob. Node has both, and `fetch` would serialise them. But
// then the runtime decides the boundary and the part's Content-Type, and the
// broker could not state what it sent. The injected FetchLike in both brokers
// also hands over a Buffer body, so a runtime-serialised form would be invisible
// to every test. The body is therefore assembled here, byte for byte.
//
// THE SHAPE IS READ OFF THE SPEC, NOT REMEMBERED (CLAUDE.md rule 5). Jira Cloud
// v3 OpenAPI, pulled 2026-09-18 from
// developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json. The
// `addAttachment` operation on POST /rest/api/3/issue/{issueIdOrKey}/attachments
// carries these sentences verbatim:
//   "Adds one or more attachments to an issue. Attachments are posted as
//    multipart/form-data ([RFC 1867](https://www.ietf.org/rfc/rfc1867.txt))."
//   "The request must have a `X-Atlassian-Token: no-check` header, if not it is
//    blocked."
//   "The name of the multipart/form-data parameter that contains the attachments
//    must be `file`."
// It declares x-atlassian-oauth2-scopes
//   [{"scheme":"OAuth2","scopes":["write:jira-work"],"state":"Current"}]
// which is the scope the service account already holds, and deprecated:false.
// Success is 200 - NOT 201 - and the payload is an ARRAY of attachments, each
// with `id` and `filename` per the documented example. 413 is documented for
// "more than 60 files are requested to be uploaded", so the array is the plural
// form of one request, not of one part.

import { basename } from "node:path";
import { randomUUID } from "node:crypto";

// The documented parameter name. Named rather than inlined so the contract test
// and the brokers refer to the same string as the comment above.
export const FILE_PART_NAME = "file";
export const XSRF_HEADER = "X-Atlassian-Token";
export const XSRF_VALUE = "no-check";

// Set explicitly on the part instead of left to a runtime's guess: a part whose
// Content-Type depends on which Node version serialises it is a behaviour nobody
// can test. Jira decides for itself what mimeType it stores - a live upload of a
// .md file came back as "text/markdown" (measured 2026-09-18 against OP-1371) -
// so this is what the broker STATES, not what Jira ends up recording. A caller
// who knows better overrides it.
export const DEFAULT_PART_CONTENT_TYPE = "application/octet-stream";

const CRLF = "\r\n";

// RFC 7230 token/token. No parameters: a value carrying ";" or whitespace would
// let a caller append header fields of their own choosing to the part.
const MEDIA_TYPE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function attachmentPath(issueKey: string): string {
  return `/issue/${encodeURIComponent(issueKey)}/attachments`;
}

/**
 * The name Jira will store, derived from the path the caller named. `basename`
 * is platform-correct by definition, which is the point: a Windows host must
 * split on its own separator and a macOS host must not, because a backslash is
 * a legal character in a POSIX file name.
 */
export function attachmentFileName(filePath: string): string {
  return basename(filePath.trim());
}

export interface MediaTypeResult {
  value?: string;
  error?: string;
}

export function partContentType(raw?: string): MediaTypeResult {
  const value = (raw ?? "").trim();
  if (!value) return { value: DEFAULT_PART_CONTENT_TYPE };
  if (!MEDIA_TYPE.test(value)) return { error: "--content-type ist kein einfacher Medientyp der Form typ/subtyp." };
  return { value };
}

/**
 * A fresh boundary per upload. 54 characters, well inside the 70 RFC 2046
 * allows, and built only from characters that RFC permits in a boundary.
 */
export function newBoundary(): string {
  return `----KherepFormBoundary${randomUUID().replace(/-/g, "")}`;
}

// WHATWG HTML, "multipart/form-data encoding algorithm", read 2026-09-18 at
// html.spec.whatwg.org/multipage/form-control-infrastructure.html, verbatim:
// "For field names and filenames for file fields, the result of the encoding in
// the previous bullet point must be escaped by replacing any 0x0A (LF) bytes
// with the byte sequence `%0A`, 0x0D (CR) with `%0D` and 0x22 (") with `%22`.
// The user agent must not perform any other escapes."
//
// This is what keeps a file name out of the header grammar it sits inside. The
// alternative - refusing such a name - would reject a file the operating system
// considers perfectly legal.
function escapeFileName(name: string): string {
  return name.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");
}

export interface UploadRequest {
  headers: Record<string, string>;
  body: Buffer;
}

export interface UploadResult {
  request?: UploadRequest;
  error?: string;
}

export interface UploadPart {
  fileName: string;
  bytes: Buffer;
  contentType: string;
  boundary: string;
}

/**
 * One file part, assembled per RFC 1867 / RFC 7578. The XSRF header travels with
 * the body rather than being left to the caller: a request that carries one and
 * not the other is the exact failure the doc warns about, and splitting them
 * across two files is how that happens.
 */
export function multipartUpload({ fileName, bytes, contentType, boundary }: UploadPart): UploadResult {
  const name = escapeFileName(fileName);
  if (!name) return { error: "Der Dateiname ist leer." };
  // RFC 2046 requires a boundary that does not occur in the enclosed body.
  // newBoundary makes a collision a 2^122 event, so this is not a expected
  // branch - it is the guard that keeps "practically impossible" from being
  // load-bearing. A collision would otherwise truncate the upload silently.
  if (bytes.includes(boundary)) return { error: "Die Datei enthaelt die erzeugte Trennmarke." };
  const head = Buffer.from(
    `--${boundary}${CRLF}`
    + `Content-Disposition: form-data; name="${FILE_PART_NAME}"; filename="${name}"${CRLF}`
    + `Content-Type: ${contentType}${CRLF}${CRLF}`,
    "utf8",
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8");
  const body = Buffer.concat([head, bytes, tail]);
  return {
    request: {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
        [XSRF_HEADER]: XSRF_VALUE,
      },
      body,
    },
  };
}

/**
 * Everything one upload needs, composed from the pure pieces above. Both brokers
 * called the same three functions with the same four properties in the same
 * order; the one value that must never be shared between two uploads - the
 * boundary - is now minted in a single place instead of twice.
 */
export function uploadRequest(filePath: string, contentType: string, bytes: Buffer): UploadResult {
  return multipartUpload({
    fileName: attachmentFileName(filePath),
    bytes,
    contentType,
    boundary: newBoundary(),
  });
}

export interface Attachment {
  id: string;
  filename: string;
}

export interface AttachmentsResult {
  attachments?: Attachment[];
  error?: string;
}

/**
 * The upload response, read rather than assumed. An empty array is an error, not
 * an empty success: a 200 that carried no attachment has not proven that a file
 * arrived, and golden rule 13 does not accept a status code as a measurement.
 */
export function readAttachments(value: unknown): AttachmentsResult {
  if (!Array.isArray(value)) return { error: "Die Upload-Antwort ist keine Anhangsliste." };
  const attachments: Attachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { error: "Ein Eintrag der Upload-Antwort ist kein Anhang." };
    const { id, filename } = entry as { id?: unknown; filename?: unknown };
    if ((typeof id !== "string" && typeof id !== "number") || typeof filename !== "string" || !filename) {
      return { error: "Ein Anhang der Upload-Antwort hat keine ID oder keinen Dateinamen." };
    }
    attachments.push({ id: String(id), filename });
  }
  if (attachments.length === 0) return { error: "Der Upload lieferte keinen Anhang zurueck." };
  return { attachments };
}

/**
 * The independent readback. The upload answer is the endpoint's report about
 * itself; this reads the work item instead (golden rule 13). The field is named
 * `attachment` - singular - and holds an array: the documented example response
 * of GET /rest/api/3/issue/{issueIdOrKey} carries `"attachment": [ ... ]` with
 * `id` and `filename` on each entry.
 */
export function confirmAttachments(fields: unknown, expected: Attachment[]): { error?: string } {
  const listed = (fields as { attachment?: unknown } | null | undefined)?.attachment;
  if (!Array.isArray(listed)) return { error: "Der Vorgang liefert keine lesbare Anhangsliste zurueck." };
  const present = new Set(listed.map((entry) => String((entry as { id?: unknown } | null)?.id)));
  const missing = expected.filter(({ id }) => !present.has(id)).map(({ id }) => id);
  return missing.length === 0
    ? {}
    : { error: `Readback bestaetigt den Anhang nicht: ${missing.join(", ")} fehlt am Vorgang.` };
}
