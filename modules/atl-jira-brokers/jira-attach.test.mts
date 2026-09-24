import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PART_CONTENT_TYPE,
  FILE_PART_NAME,
  XSRF_HEADER,
  XSRF_VALUE,
  attachmentFileName,
  attachmentPath,
  confirmAttachments,
  multipartUpload,
  newBoundary,
  partContentType,
  readAttachments,
  uploadRequest,
} from "./jira-attach.mts";

const BOUNDARY = "----KherepFormBoundaryFixedForTests";

function upload(bytes: Buffer, fileName = "note.md", contentType = DEFAULT_PART_CONTENT_TYPE) {
  return multipartUpload({ fileName, bytes, contentType, boundary: BOUNDARY });
}

test("the part is named file, as the documented parameter name requires", () => {
  const { request } = upload(Buffer.from("hallo", "utf8"));
  const body = request!.body.toString("utf8");
  assert.equal(FILE_PART_NAME, "file");
  assert.match(body, /Content-Disposition: form-data; name="file"; filename="note\.md"/);
});

test("the upload carries the XSRF header and a multipart content type, never JSON", () => {
  const { request } = upload(Buffer.from("hallo", "utf8"));
  assert.equal(request!.headers[XSRF_HEADER], XSRF_VALUE);
  assert.equal(XSRF_VALUE, "no-check");
  assert.equal(request!.headers["Content-Type"], `multipart/form-data; boundary=${BOUNDARY}`);
  assert.equal(request!.headers["Content-Type"].includes("application/json"), false);
});

test("the body is a well formed single part with an explicit part content type", () => {
  const { request } = upload(Buffer.from("hallo", "utf8"));
  const body = request!.body.toString("utf8");
  assert.equal(
    body,
    `--${BOUNDARY}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="note.md"\r\n`
    + `Content-Type: application/octet-stream\r\n\r\n`
    + `hallo\r\n--${BOUNDARY}--\r\n`,
  );
  assert.equal(request!.headers["Content-Length"], String(request!.body.length));
});

test("binary bytes survive the assembly unchanged", () => {
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x00]);
  const { request } = upload(bytes, "picture.png", "image/png");
  const body = request!.body;
  const start = body.indexOf(Buffer.from("\r\n\r\n", "utf8")) + 4;
  assert.deepEqual(body.subarray(start, start + bytes.length), bytes);
  assert.match(body.toString("latin1"), /Content-Type: image\/png/);
});

test("a file name cannot escape the header it sits inside", () => {
  const { request } = upload(Buffer.from("x", "utf8"), 'ev"il\r\nX-Injected: 1.txt');
  const body = request!.body.toString("utf8");
  assert.match(body, /filename="ev%22il%0D%0AX-Injected: 1\.txt"/);
  assert.equal(body.includes("\r\nX-Injected: 1"), false);
});

test("a boundary occurring in the file is refused instead of truncating the upload", () => {
  const { request, error } = upload(Buffer.from(`before--${BOUNDARY}--after`, "utf8"));
  assert.equal(request, undefined);
  assert.match(String(error), /Trennmarke/);
});

test("an empty file name is refused", () => {
  assert.match(String(upload(Buffer.from("x", "utf8"), "").error), /Dateiname/);
});

test("attachmentFileName takes the basename of the path the caller named", () => {
  assert.equal(attachmentFileName("/tmp/reports/2026-09-18-design.md"), "2026-09-18-design.md");
  assert.equal(attachmentFileName("  note.txt  "), "note.txt");
});

test("attachmentPath escapes the key it is given", () => {
  assert.equal(attachmentPath("OP-1396"), "/issue/OP-1396/attachments");
  assert.equal(attachmentPath("OP 1"), "/issue/OP%201/attachments");
});

test("partContentType defaults explicitly and refuses anything but one media type", () => {
  assert.equal(partContentType(undefined).value, DEFAULT_PART_CONTENT_TYPE);
  assert.equal(partContentType("").value, DEFAULT_PART_CONTENT_TYPE);
  assert.equal(partContentType(" text/markdown ").value, "text/markdown");
  for (const bad of ["text", "text/plain; charset=utf8", "text/plain\r\nX: 1", "*/*;q=1"]) {
    assert.match(String(partContentType(bad).error), /--content-type/, `accepted ${bad}`);
  }
});

test("newBoundary is fresh, RFC-legal and inside the length limit", () => {
  const first = newBoundary();
  assert.notEqual(first, newBoundary());
  assert.ok(first.length <= 70, `boundary is ${first.length} characters`);
  assert.match(first, /^[A-Za-z0-9'()+_,\-./:=?-]+$/);
});

test("uploadRequest names the file from its path and mints a fresh boundary each time", () => {
  const first = uploadRequest("/tmp/reports/design.md", "text/markdown", Buffer.from("x", "utf8"));
  const second = uploadRequest("/tmp/reports/design.md", "text/markdown", Buffer.from("x", "utf8"));
  const body = first.request!.body.toString("utf8");
  assert.match(body, /filename="design\.md"/);
  assert.match(body, /Content-Type: text\/markdown/);
  assert.match(first.request!.headers["Content-Type"], /^multipart\/form-data; boundary=----KherepFormBoundary/);
  assert.notEqual(first.request!.headers["Content-Type"], second.request!.headers["Content-Type"]);
  // The failure of the part it composes still travels out of it.
  assert.match(String(uploadRequest("/", "text/plain", Buffer.from("x", "utf8")).error), /Dateiname/);
});

test("readAttachments reports the id and filename of every attachment", () => {
  const { attachments, error } = readAttachments([
    { id: "10222", filename: "design.md", size: 33159 },
    { id: 10223, filename: "picture.png" },
  ]);
  assert.equal(error, undefined);
  assert.deepEqual(attachments, [
    { id: "10222", filename: "design.md" },
    { id: "10223", filename: "picture.png" },
  ]);
});

test("readAttachments treats an empty or unreadable answer as unproven, not as success", () => {
  assert.match(String(readAttachments([]).error), /keinen Anhang/);
  assert.match(String(readAttachments({ id: "1", filename: "x" }).error), /Anhangsliste/);
  assert.match(String(readAttachments(null).error), /Anhangsliste/);
  assert.match(String(readAttachments([{ filename: "x" }]).error), /keine ID/);
  assert.match(String(readAttachments([{ id: "1" }]).error), /Dateinamen/);
  assert.match(String(readAttachments(["x"]).error), /kein Anhang/);
});

test("confirmAttachments measures the work item, not the upload answer", () => {
  const uploaded = [{ id: "10222", filename: "design.md" }];
  assert.deepEqual(confirmAttachments({ attachment: [{ id: "10222", filename: "design.md" }] }, uploaded), {});
  assert.deepEqual(confirmAttachments({ attachment: [{ id: 10222 }] }, uploaded), {});
  assert.match(String(confirmAttachments({ attachment: [{ id: "99" }] }, uploaded).error), /10222 fehlt/);
  assert.match(String(confirmAttachments({}, uploaded).error), /keine lesbare Anhangsliste/);
  assert.match(String(confirmAttachments(undefined, uploaded).error), /keine lesbare Anhangsliste/);
});
