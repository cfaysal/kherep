import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachmentContentPath,
  attachmentListPath,
  decideOutput,
  formatAttachmentLine,
  isPrintableMediaType,
  readAttachmentList,
  readAttachmentMeta,
  selectAttachment,
  verifyDownload,
} from "./jira-download.mts";

// The three shapes measured against the live site on 2026-09-18 (OP-1396).
// Modelled here rather than fetched: no test in this module touches a network.
const MARKDOWN_LARGE = { id: "10222", filename: "handover.md", mimeType: "text/markdown", size: 33159 };
const OCTET_SMALL = { id: "10223", filename: "notes.bin", mimeType: "application/octet-stream", size: 401 };
const MARKDOWN_SMALL = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: 401 };

// A download starts at the work item, not at the attachment: that is what makes
// --key bind. See attachmentListPath for why the metadata endpoint cannot serve.
test("the list path is the work item's own attachment field and escapes the key", () => {
  assert.equal(attachmentListPath("OP-1396"), "/issue/OP-1396?fields=attachment");
  assert.equal(attachmentListPath("a/b"), "/issue/a%2Fb?fields=attachment");
});

// THE REPORTED DEFECT, in one test: the id belongs to a different work item.
test("an attachment of another work item is refused, naming both values", () => {
  const { meta, error } = selectAttachment([MARKDOWN_SMALL], "10222", "OP-1396");
  assert.equal(meta, undefined);
  assert.match(error ?? "", /10222/);
  assert.match(error ?? "", /OP-1396/);
  // The ids that ARE there, so the typo is visible.
  assert.match(error ?? "", /10224/);
});

test("the attachment that does hang off the work item comes back whole", () => {
  assert.deepEqual(selectAttachment([MARKDOWN_LARGE, OCTET_SMALL], "10223", "OP-1396").meta, OCTET_SMALL);
});

test("a work item without attachments says so rather than listing nothing", () => {
  const { error } = selectAttachment([], "10222", "OP-1396");
  assert.match(error ?? "", /keine Anhaenge/);
  assert.match(error ?? "", /OP-1396/);
});

// The documented single-request download. `redirect=false` is not a convenience:
// the spec ties the 200 to it, and without it the answer is a 303 the injected
// fetch of every test would have to follow.
test("the content path pins redirect=false", () => {
  assert.equal(attachmentContentPath("10222"), "/attachment/content/10222?redirect=false");
  assert.match(attachmentContentPath("10223"), /\?redirect=false$/);
});

test("metadata is read rather than assumed", () => {
  const { meta, error } = readAttachmentMeta(MARKDOWN_LARGE);
  assert.equal(error, undefined);
  assert.deepEqual(meta, MARKDOWN_LARGE);
});

test("a numeric id is accepted and normalised, as the upload reader does it", () => {
  const { meta } = readAttachmentMeta({ ...OCTET_SMALL, id: 10223 });
  assert.equal(meta?.id, "10223");
});

test("metadata without a stored mimeType is an error, not a default", () => {
  // Guessing here would defeat the whole point: the sink decision is made from
  // the stored type, so an absent type must stop the command, not fall back to
  // something printable.
  assert.match(readAttachmentMeta({ id: "1", filename: "a", size: 1 }).error ?? "", /Medientyp/);
  assert.match(readAttachmentMeta({ id: "1", filename: "a", mimeType: "", size: 1 }).error ?? "", /Medientyp/);
});

test("metadata without a readable size is an error", () => {
  assert.ok(readAttachmentMeta({ id: "1", filename: "a", mimeType: "text/plain" }).error);
  assert.ok(readAttachmentMeta({ id: "1", filename: "a", mimeType: "text/plain", size: -1 }).error);
});

test("a non-object payload is an error", () => {
  assert.ok(readAttachmentMeta(null).error);
  assert.ok(readAttachmentMeta("10222").error);
  assert.ok(readAttachmentMeta([MARKDOWN_LARGE]).error);
});

test("every text/* subtype prints, including ones nobody enumerated", () => {
  for (const type of ["text/plain", "text/markdown", "text/csv", "text/html", "text/x-log"]) {
    assert.equal(isPrintableMediaType(type), true, type);
  }
});

test("structured text outside text/* prints too", () => {
  for (const type of ["application/json", "application/xml", "application/yaml", "application/vnd.api+json", "image/svg+xml"]) {
    assert.equal(isPrintableMediaType(type), true, type);
  }
});

test("opaque bytes never print", () => {
  for (const type of ["application/octet-stream", "application/pdf", "image/png", "application/zip", ""]) {
    assert.equal(isPrintableMediaType(type), false, type);
  }
});

test("parameters and casing do not change the decision", () => {
  assert.equal(isPrintableMediaType("TEXT/Markdown; charset=utf-8"), true);
  assert.equal(isPrintableMediaType("  application/octet-stream ; x=1"), false);
});

test("a printable attachment goes to stdout so an agent can pipe it", () => {
  assert.deepEqual(decideOutput(MARKDOWN_SMALL, undefined, false), { print: true });
  // A printable type needs no permission and is unaffected by the terminal: the
  // site said it is text, and text is what a terminal is for.
  assert.deepEqual(decideOutput(MARKDOWN_LARGE, undefined, true), { print: true });
});

// The defect that opened OP-1396 in reverse: a 401-byte octet-stream looks
// harmless and is still not something to spray at a terminal unasked.
test("an opaque attachment is refused, and the message names the type and the way out", () => {
  const { print, error } = decideOutput(OCTET_SMALL, undefined, false);
  assert.equal(print, undefined);
  assert.match(error ?? "", /application\/octet-stream/);
  assert.match(error ?? "", /--accept application\/octet-stream/);
  assert.match(error ?? "", /umleiten/);
});

// THE CASE THAT DECIDED THE DESIGN. attach stores application/octet-stream
// whenever no --content-type is given, so a blanket refusal would leave the
// broker unable to read back a file it wrote itself. 10223 is that file.
test("an opaque attachment the caller accepted by name is delivered when stdout is redirected", () => {
  assert.deepEqual(decideOutput(OCTET_SMALL, "application/octet-stream", false), { print: true });
});

test("the acceptance must name the stored type, not merely be present", () => {
  assert.ok(decideOutput(OCTET_SMALL, "text/markdown", false).error);
  assert.ok(decideOutput(OCTET_SMALL, "yes", false).error);
  assert.ok(decideOutput(OCTET_SMALL, "", false).error);
});

test("acceptance is matched without casing or parameters getting in the way", () => {
  assert.deepEqual(decideOutput(OCTET_SMALL, "Application/Octet-Stream; charset=x", false), { print: true });
});

// The literal hazard from the brief: bytes of unknown shape reaching a terminal.
test("even an accepted opaque attachment never reaches a terminal", () => {
  const { print, error } = decideOutput(OCTET_SMALL, "application/octet-stream", true);
  assert.equal(print, undefined);
  assert.match(error ?? "", /Terminal/);
});

// Golden rule 13: the status code is not the measurement. The bytes are.
test("a short read is caught against the size the site stored", () => {
  assert.equal(verifyDownload(Buffer.alloc(401), MARKDOWN_SMALL).error, undefined);
  assert.match(verifyDownload(Buffer.alloc(400), MARKDOWN_SMALL).error ?? "", /401/);
  assert.ok(verifyDownload(Buffer.alloc(0), MARKDOWN_SMALL).error);
});

test("the attachment list stays quiet when the issue has none", () => {
  assert.deepEqual(readAttachmentList({ attachment: [] }), { entries: [] });
  assert.deepEqual(readAttachmentList({}), { entries: [] });
  assert.deepEqual(readAttachmentList(null), { entries: [] });
});

test("the attachment list carries the four columns the caller needs", () => {
  const { entries, error } = readAttachmentList({ attachment: [MARKDOWN_LARGE, OCTET_SMALL] });
  assert.equal(error, undefined);
  assert.deepEqual(entries, [MARKDOWN_LARGE, OCTET_SMALL]);
});

// Rule 12: an entry that could not be read must not leave the list looking
// merely short. The reason travels with the result.
test("an unreadable entry is reported beside the ones that did read", () => {
  const { entries, error } = readAttachmentList({ attachment: [MARKDOWN_LARGE, { filename: "no-id.md" }] });
  assert.deepEqual(entries, [MARKDOWN_LARGE]);
  assert.ok(error);
});

test("one line per attachment, in the order the site returned them", () => {
  assert.equal(formatAttachmentLine(MARKDOWN_LARGE), "10222 handover.md text/markdown 33159");
});
