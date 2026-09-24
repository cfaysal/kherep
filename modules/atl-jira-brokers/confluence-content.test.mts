// Verb tests. The session is injected, so most of these assert the exact
// request a verb builds; the status-mapping tests use the real session over a
// stub fetch, because "a 403 on THIS verb names THIS scope" is only true if the
// verb and the transport are held together.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfluenceError,
  ConfluenceRequestError,
  SCOPES,
  type ConfluenceSession,
  type RequestSpec,
} from "./confluence-contract.mts";
import {
  addLabels,
  listLabels,
  removeLabels,
  createPage,
  deletePage,
  findSpace,
  getPage,
  listChildren,
  movePage,
  purgePage,
  representationFor,
  updatePage,
} from "./confluence-content.mts";
import { createSession, type ConfluenceContext, type HttpResponse } from "./confluence-session.mts";

const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = "Client ID: client-id-for-tests\nSecret: secret-for-tests-1234\n";

// Records what a verb asks for and answers with canned bodies, in order.
function recorder(bodies: unknown[] = []) {
  const specs: RequestSpec[] = [];
  const session: ConfluenceSession = {
    async request(spec) {
      specs.push(spec);
      return { status: 200, json: bodies[specs.length - 1] ?? {} };
    },
  };
  return { session, specs };
}

// A session that would fail the test if anything called it.
const NEVER: ConfluenceSession = {
  async request() {
    throw new Error("no request may be sent");
  },
};

function statusSession(status: number, body: unknown): ConfluenceSession {
  const answer = (value: unknown): HttpResponse => ({
    status,
    ok: status >= 200 && status < 300,
    async json() { return value ?? {}; },
    async text() { return JSON.stringify(value ?? {}); },
  });
  const ctx: ConfluenceContext = {
    env: { KHEREP_ATL_SITE: "https://wiki.example.com", KHEREP_ATL_CRED_FILE_CLAUDE: CRED_PATH },
    credEnv: "KHEREP_ATL_CRED_FILE_CLAUDE",
    async readFile() { return CRED_TEXT; },
    async fetch(url) {
      if (url.startsWith("https://auth.atlassian.com")) {
        return { status: 200, ok: true, async json() { return { access_token: "t", expires_in: 3600 }; }, async text() { return "{}"; } };
      }
      if (url.endsWith("/_edge/tenant_info")) {
        return { status: 200, ok: true, async json() { return { cloudId: "cloud-id-for-tests" }; }, async text() { return "{}"; } };
      }
      return answer(body);
    },
    now: () => 1_000_000,
    session: {},
  };
  return createSession(ctx);
}

const PAGE = {
  id: "5001",
  title: "Existing title",
  status: "current",
  spaceId: "9001",
  authorId: "service-account-for-tests",
  version: { number: 7 },
  _links: { webui: "/spaces/KB/pages/5001" },
};

test("the three documented representations map, and nothing else does", () => {
  assert.equal(representationFor("storage"), "storage");
  assert.equal(representationFor("wiki"), "wiki");
  assert.equal(representationFor("adf"), "atlas_doc_format");
  for (const bad of ["markdown", "md", "html", "atlas_doc_format", "", undefined]) {
    assert.throws(() => representationFor(bad), ConfluenceError, `"${bad}" must be refused`);
  }
});

test("an unsupported format is refused before any request is built", async () => {
  // The verbs take an already-mapped representation, so the refusal has to
  // happen at the mapping. Proven by handing the verb a session that throws.
  assert.throws(() => representationFor("markdown"), /not a Confluence representation/);
  await assert.rejects(() => getPage(NEVER, "not-a-number"), ConfluenceError);
});

test("create posts the documented body and returns the authorId", async () => {
  const { session, specs } = recorder([PAGE]);
  const page = await createPage(session, {
    spaceId: "9001", title: "New page", representation: "storage", value: "<p>x</p>",
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].method, "POST");
  assert.equal(specs[0].path, "/wiki/api/v2/pages");
  assert.equal(specs[0].scope, SCOPES.create);
  assert.deepEqual(specs[0].body, {
    spaceId: "9001",
    status: "current",
    title: "New page",
    body: { representation: "storage", value: "<p>x</p>" },
  });
  assert.equal(page.authorId, "service-account-for-tests");
  assert.equal(page.version, 7);
  assert.equal(page.link, "/spaces/KB/pages/5001");
});

test("create carries parentId only when one was given", async () => {
  const { session, specs } = recorder([PAGE]);
  await createPage(session, {
    spaceId: "9001", title: "Child", representation: "wiki", value: "x", parentId: "5001",
  });
  assert.equal((specs[0].body as { parentId?: string }).parentId, "5001");
});

test("a 413 on create is a size failure, a 403 is a scope failure", async () => {
  await assert.rejects(
    () => createPage(statusSession(413, { message: "too large" }), {
      spaceId: "9001", title: "t", representation: "storage", value: "x",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceRequestError);
      assert.equal(error.kind, "too-large");
      assert.doesNotMatch(error.cliMessage, /scope/);
      return true;
    },
  );
  await assert.rejects(
    () => createPage(statusSession(403, {}), { spaceId: "9001", title: "t", representation: "storage", value: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceRequestError);
      assert.equal(error.kind, "forbidden");
      assert.match(error.cliMessage, /write:page:confluence/);
      return true;
    },
  );
});

test("a 403 names the scope of the verb that was attempted", async () => {
  const attempts: [string, () => Promise<unknown>, string][] = [
    ["get", () => getPage(statusSession(403, {}), "5001"), SCOPES.get],
    ["delete", () => deletePage(statusSession(403, {}), "5001"), SCOPES.delete],
    ["labels", () => addLabels(statusSession(403, {}), "5001", ["a"]), SCOPES.labels],
    ["space", () => findSpace(statusSession(403, {}), "KB"), SCOPES.space],
    ["children", () => listChildren(statusSession(403, {}), "5001"), SCOPES.children],
  ];
  for (const [name, run, scope] of attempts) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof ConfluenceRequestError, name);
      assert.match(error.cliMessage, new RegExp(scope), `${name} does not name ${scope}`);
      return true;
    });
  }
});

test("update sends the version number it read, not one the caller supplied", async () => {
  const { session, specs } = recorder([PAGE, { ...PAGE, version: { number: 8 } }]);
  const result = await updatePage(session, {
    id: "5001", representation: "storage", value: "<p>new</p>", message: "why",
  });
  assert.equal(specs[0].method, "GET", "the current version must be read first");
  assert.equal(specs[1].method, "PUT");
  assert.equal(specs[1].path, "/wiki/api/v2/pages/5001");
  const body = specs[1].body as { version: { number: number; message: string }; title: string; id: string };
  // Read 7, so 8 goes out. A caller holding a stale 3 cannot reach this number.
  assert.equal(result.readVersion, 7);
  assert.equal(body.version.number, 8);
  assert.equal(body.version.message, "why");
  // No title given, so the one that was read is kept rather than blanked.
  assert.equal(body.title, "Existing title");
  assert.equal(body.id, "5001");
});

test("update refuses a page that reports no version rather than inventing one", async () => {
  const { session, specs } = recorder([{ id: "5001", title: "t", status: "current" }]);
  await assert.rejects(
    () => updatePage(session, { id: "5001", representation: "storage", value: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceError);
      assert.match(error.cliMessage, /refusing to invent one/);
      return true;
    },
  );
  assert.equal(specs.length, 1, "no write may follow an unknown version");
});

test("purge refuses a page that is not already trashed and sends no delete", async () => {
  const { session, specs } = recorder([PAGE]);
  await assert.rejects(
    () => purgePage(session, "5001"),
    (error: unknown) => {
      assert.ok(error instanceof ConfluenceError);
      assert.match(error.cliMessage, /not "trashed"/);
      assert.match(error.cliMessage, /run delete first/);
      return true;
    },
  );
  assert.equal(specs.length, 1, "purge must not reach a DELETE on a live page");
  assert.equal(specs[0].method, "GET");
});

test("purge runs against a trashed page with purge=true", async () => {
  const { session, specs } = recorder([{ ...PAGE, status: "trashed" }, null]);
  await purgePage(session, "5001");
  assert.equal(specs[1].method, "DELETE");
  assert.equal(specs[1].path, "/wiki/api/v2/pages/5001?purge=true");
  assert.equal(specs[1].scope, SCOPES.purge);
});

test("delete moves the page to the trash through v2 without purge", async () => {
  const { session, specs } = recorder([null]);
  await deletePage(session, "5001");
  assert.equal(specs[0].method, "DELETE");
  assert.equal(specs[0].path, "/wiki/api/v2/pages/5001");
  assert.doesNotMatch(specs[0].path, /purge/);
});

test("labels post a JSON array to the v1 path, never to v2", async () => {
  const { session, specs } = recorder([{ results: [{ name: "alpha" }, { name: "beta" }] }]);
  const added = await addLabels(session, "5001", [" alpha ", "beta", "  "]);
  assert.equal(specs[0].method, "POST");
  assert.equal(specs[0].path, "/wiki/rest/api/content/5001/label");
  assert.doesNotMatch(specs[0].path, /api\/v2/);
  assert.ok(Array.isArray(specs[0].body), "the v1 label endpoint takes an array, not an object");
  assert.deepEqual(specs[0].body, [{ prefix: "global", name: "alpha" }, { prefix: "global", name: "beta" }]);
  assert.deepEqual(added, ["alpha", "beta"]);
});

test("labels refuse an empty list instead of posting nothing", async () => {
  const { session, specs } = recorder();
  await assert.rejects(() => addLabels(session, "5001", ["", "  "]), ConfluenceError);
  assert.equal(specs.length, 0);
});

test("label removal deletes each name through the v1 query form, then reads the page's labels back", async () => {
  const { session, specs } = recorder([null, null, { results: [{ name: "keep" }] }]);
  const left = await removeLabels(session, "5001", [" evidence-confirmed ", "a/b", " "]);
  assert.deepEqual(specs.map((spec) => [spec.method, spec.path]), [
    ["DELETE", "/wiki/rest/api/content/5001/label?name=evidence-confirmed"],
    ["DELETE", "/wiki/rest/api/content/5001/label?name=a%2Fb"],
    ["GET", "/wiki/api/v2/pages/5001/labels?limit=250"],
  ]);
  assert.equal(specs[0].scope, SCOPES.labels);
  assert.deepEqual(left, ["keep"]);
});

test("label removal refuses an empty list instead of sending nothing", async () => {
  await assert.rejects(() => removeLabels(NEVER, "5001", ["", "  "]), ConfluenceError);
});

test("the label list follows the next link to exhaustion", async () => {
  const { session, specs } = recorder([
    { results: [{ name: "a" }], _links: { next: "/api/v2/pages/5001/labels?cursor=c1" } },
    { results: [{ name: "b" }] },
  ]);
  assert.deepEqual(await listLabels(session, "5001"), ["a", "b"]);
  assert.equal(specs[1].path, "/wiki/api/v2/pages/5001/labels?cursor=c1");
});

test("a space is looked up by exact key and a near miss is not adopted", async () => {
  const { session, specs } = recorder([{ results: [{ id: "9001", key: "KB", name: "Knowledge" }] }]);
  assert.deepEqual(await findSpace(session, "KB"), { id: "9001", key: "KB", name: "Knowledge" });
  assert.equal(specs[0].path, "/wiki/api/v2/spaces?keys=KB");
  const near = recorder([{ results: [{ id: "9002", key: "KBX", name: "Other" }] }]);
  assert.equal(await findSpace(near.session, "KB"), null);
});

test("children are read from the v2 child endpoint", async () => {
  const { session, specs } = recorder([{ results: [{ id: "6001", title: "One" }, { id: "6002", title: "Two" }] }]);
  assert.deepEqual(await listChildren(session, "5001"), [
    { id: "6001", title: "One" },
    { id: "6002", title: "Two" },
  ]);
  assert.equal(specs[0].path, "/wiki/api/v2/pages/5001/children?limit=250");
});

// Der Defekt, den dieser Test festhaelt, ist am 2026-09-21 live aufgetreten: vier
// Elternseiten mit 26, 26, 63 und 65 Kindern meldeten alle exakt 25. Eine gekappte
// Liste, die vollstaendig aussieht, ist schlimmer als ein Fehler - niemand stellt
// einer plausiblen Zahl eine zweite Frage.
test("children are followed across pages until the cursor runs out", async () => {
  const { session, specs } = recorder([
    { results: [{ id: "6001", title: "One" }], _links: { next: "/api/v2/pages/5001/children?cursor=abc" } },
    { results: [{ id: "6002", title: "Two" }], _links: { next: "/wiki/api/v2/pages/5001/children?cursor=def" } },
    { results: [{ id: "6003", title: "Three" }] },
  ]);
  assert.deepEqual((await listChildren(session, "5001")).map((c) => c.id), ["6001", "6002", "6003"]);
  assert.equal(specs.length, 3);
  assert.equal(specs[1].path, "/wiki/api/v2/pages/5001/children?cursor=abc");
  assert.equal(specs[2].path, "/wiki/api/v2/pages/5001/children?cursor=def");
});

// Ein Cursor, der auf dieselbe Seite zeigt, darf nicht endlos kreisen.
test("a cursor that yields nothing new ends the walk", async () => {
  const page = { results: [{ id: "6001", title: "One" }], _links: { next: "/api/v2/pages/5001/children?cursor=same" } };
  const { session, specs } = recorder([page, page, page]);
  assert.deepEqual((await listChildren(session, "5001")).map((c) => c.id), ["6001"]);
  assert.equal(specs.length, 2, "nach einer Seite ohne neue Kinder wird abgebrochen");
});

test("an id that is not a Confluence content id never reaches a path", async () => {
  for (const bad of ["", "   ", "../../admin", "5001/children", "abc"]) {
    const { session, specs } = recorder();
    await assert.rejects(() => getPage(session, bad), ConfluenceError, `"${bad}" must be refused`);
    assert.equal(specs.length, 0);
  }
});

// movePage darf NUR den Elternknoten aendern. Es liest den Storage-Rumpf und
// schickt ihn unveraendert zurueck, weil jede Abweichung zwischen Gelesenem und
// Gesendetem eine stille Inhaltsaenderung waere - getarnt als Umzug.
test("moving a page sends the parent and returns the body it read", async () => {
  const { session, specs } = recorder([
    { id: "7001", title: "Kept", parentId: "8001", version: { number: 4 }, body: { storage: { value: "<p>unchanged</p>" } } },
    { id: "7001", title: "Kept", parentId: "9001", version: { number: 5 } },
  ]);
  const result = await movePage(session, "7001", "9001");
  assert.equal(result.fromParent, "8001");
  assert.equal(result.toParent, "9001");
  assert.equal(specs[0].path, "/wiki/api/v2/pages/7001?body-format=storage");
  const sent = specs[1].body as { parentId: string; title: string; version: { number: number }; body: { value: string } };
  assert.equal(specs[1].method, "PUT");
  assert.equal(sent.parentId, "9001");
  assert.equal(sent.title, "Kept", "der Titel bleibt der gelesene");
  assert.equal(sent.body.value, "<p>unchanged</p>", "der Rumpf geht unveraendert zurueck");
  assert.equal(sent.version.number, 5, "die Version kommt aus dem Lesen, nicht vom Aufrufer");
});

// Ein Umzug auf den Knoten, unter dem die Seite schon haengt, ist kein Umzug.
// Eine PUT dafuer zu senden erzeugte eine Version ohne Unterschied.
test("moving a page to its current parent sends no write", async () => {
  const { session, specs } = recorder([
    { id: "7001", title: "Kept", parentId: "9001", version: { number: 4 }, body: { storage: { value: "<p>x</p>" } } },
  ]);
  const result = await movePage(session, "7001", "9001");
  assert.equal(result.toParent, "9001");
  assert.equal(specs.length, 1, "nur der Lesevorgang");
});

test("a page cannot be moved under itself", async () => {
  await assert.rejects(() => movePage(NEVER, "7001", "7001"), ConfluenceError);
});

test("a page with no version number is not moved", async () => {
  const { session, specs } = recorder([
    { id: "7001", title: "Kept", parentId: "8001", body: { storage: { value: "<p>x</p>" } } },
  ]);
  await assert.rejects(() => movePage(session, "7001", "9001"), ConfluenceError);
  assert.equal(specs.length, 1, "ohne Version wird nichts geschrieben");
});
