// CLI tests for the Claude Confluence broker. Injected fetch and readFile,
// synthetic values only: nothing here reads a credential file or reaches a
// network. The Codex broker's test file is the same suite against the other
// credential variable - a property that holds on one broker by accident is not
// a property.
import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, runCli, type Injected } from "./atl-confluence-ccoder.mts";
import type { HttpResponse, RequestOptions } from "./confluence-session.mts";

const BROKER = "atl-confluence-ccoder.mts";
const OWN_ENV = "KHEREP_ATL_CRED_FILE_CLAUDE";
const FOREIGN_ENV = "KHEREP_ATL_CRED_FILE_CODEX";

const CLIENT_ID = "client-id-for-tests";
const CLIENT_SECRET = "secret-for-tests-1234";
const ACCESS_TOKEN = "access-token-must-never-be-reported";
const CLOUD_ID = "cloud-id-for-tests";
const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = `Client ID: ${CLIENT_ID}\nSecret: ${CLIENT_SECRET}\n`;
const SITE = "https://wiki.example.com";
const AUTHOR = "service-account-for-tests";

interface Call {
  url: string;
  options?: RequestOptions;
}

function response(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body ?? {}; },
    async text() { return body === undefined ? "" : JSON.stringify(body); },
  };
}

const SPACE = { results: [{ id: "9001", key: "KB", name: "Knowledge" }] };
const PAGE = {
  id: "5001",
  title: "New page",
  status: "current",
  spaceId: "9001",
  authorId: AUTHOR,
  version: { number: 1 },
  _links: { webui: "/spaces/KB/pages/5001" },
};

function harness(options: { env?: Record<string, string | undefined>; api?: (call: Call) => HttpResponse } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const injected: Injected = {
    env: options.env ?? { KHEREP_ATL_SITE: SITE, [OWN_ENV]: CRED_PATH },
    async readFile(path) {
      if (path !== CRED_PATH) throw new Error("no such file");
      return CRED_TEXT;
    },
    async fetch(url, requestOptions) {
      calls.push({ url, options: requestOptions });
      if (url.startsWith("https://auth.atlassian.com")) {
        return response(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
      }
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: CLOUD_ID });
      return options.api ? options.api({ url, options: requestOptions }) : response(200, {});
    },
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
  };
  return { out, err, calls, injected, printed: () => [...out, ...err].join("\n") };
}

function defaultApi(call: Call): HttpResponse {
  if (call.url.includes("/spaces?keys=")) return response(200, SPACE);
  if (call.url.endsWith("/wiki/api/v2/pages")) return response(200, PAGE);
  if (call.url.includes("/wiki/api/v2/pages/5001")) return response(200, PAGE);
  return response(200, {});
}

test(`${BROKER} parses flags into a plain map`, () => {
  assert.deepEqual(parseArgs(["--id", "5001", "--format", "storage"]), { id: "5001", format: "storage" });
});

test(`${BROKER} reads only ${OWN_ENV}`, async () => {
  const { err, calls, injected } = harness({ env: { KHEREP_ATL_SITE: SITE, [FOREIGN_ENV]: CRED_PATH } });
  assert.equal(await runCli(["get", "--id", "5001"], injected), 1);
  assert.deepEqual(err, [`${OWN_ENV} is not set.`]);
  assert.deepEqual(calls, [], "a missing credential variable must fail before any request");
});

test(`${BROKER} names its own variable even when the foreign one points at a readable file`, async () => {
  const { err, injected } = harness({
    env: { KHEREP_ATL_SITE: SITE, [FOREIGN_ENV]: CRED_PATH, [OWN_ENV]: undefined },
  });
  assert.equal(await runCli(["selftest"], injected), 1);
  assert.match(err.join("\n"), new RegExp(`${OWN_ENV} is not set`));
  assert.doesNotMatch(err.join("\n"), new RegExp(FOREIGN_ENV));
});

test(`${BROKER} refuses an unsupported --format before sending anything`, async () => {
  for (const format of ["markdown", "html", undefined]) {
    const { err, calls, injected } = harness({ api: defaultApi });
    const argv = ["create", "--space", "KB", "--title", "T", "--body", "x"];
    if (format !== undefined) argv.push("--format", format);
    assert.equal(await runCli(argv, injected), 1);
    assert.deepEqual(calls, [], `--format ${format} still sent a request`);
    assert.match(err.join("\n"), /--format/);
  }
});

test(`${BROKER} creates a page and proves the author by reading it back`, async () => {
  const { out, calls, injected } = harness({ api: defaultApi });
  const code = await runCli(
    ["create", "--space", "KB", "--title", "New page", "--body", "<p>x</p>", "--format", "storage"],
    injected,
  );
  assert.equal(code, 0);
  assert.match(out.join("\n"), new RegExp(`^authorId: ${AUTHOR}$`, "m"));
  assert.match(out.join("\n"), new RegExp(`^readback authorId: ${AUTHOR}$`, "m"));
  const created = calls.find((call) => call.options?.method === "POST" && call.url.endsWith("/wiki/api/v2/pages"));
  assert.ok(created, "no create request was sent");
  assert.deepEqual(JSON.parse(String(created.options?.body)), {
    spaceId: "9001",
    status: "current",
    title: "New page",
    body: { representation: "storage", value: "<p>x</p>" },
  });
  // The readback is a second, separate GET on the created page.
  assert.ok(calls.some((call) => call.options?.method === "GET" && call.url.includes("/wiki/api/v2/pages/5001")));
});

test(`${BROKER} reports UNVERIFIED authorship rather than a silent success`, async () => {
  const { out, err, injected } = harness({
    api: (call) => {
      if (call.url.includes("/spaces?keys=")) return response(200, SPACE);
      if (call.url.endsWith("/wiki/api/v2/pages")) return response(200, { ...PAGE, authorId: undefined });
      return response(200, { ...PAGE, authorId: undefined });
    },
  });
  const code = await runCli(
    ["create", "--space", "KB", "--title", "T", "--body", "x", "--format", "storage"],
    injected,
  );
  assert.equal(code, 1);
  assert.match(out.join("\n"), /readback authorId: UNKNOWN/);
  assert.match(err.join("\n"), /UNVERIFIED/);
});

test(`${BROKER} surfaces a 403 with the scope the verb needs`, async () => {
  const { err, injected } = harness({ api: () => response(403, { message: "Current user not permitted" }) });
  assert.equal(await runCli(["get", "--id", "5001"], injected), 1);
  assert.match(err.join("\n"), /read:page:confluence/);
});

test(`${BROKER} surfaces a 413 on create as a size failure`, async () => {
  const { err, injected } = harness({
    api: (call) => (call.url.includes("/spaces?keys=") ? response(200, SPACE) : response(413, { message: "too large" })),
  });
  assert.equal(await runCli(
    ["create", "--space", "KB", "--title", "T", "--body", "x", "--format", "storage"],
    injected,
  ), 1);
  assert.match(err.join("\n"), /5 MB/);
  assert.doesNotMatch(err.join("\n"), /write:page:confluence/);
});

test(`${BROKER} refuses to purge a page that is not trashed`, async () => {
  const { err, calls, injected } = harness({ api: () => response(200, PAGE) });
  assert.equal(await runCli(["purge", "--id", "5001"], injected), 1);
  assert.match(err.join("\n"), /not "trashed"/);
  assert.equal(calls.filter((call) => call.options?.method === "DELETE").length, 0);
});

test(`${BROKER} prints a usage line for an unknown verb`, async () => {
  const { err, calls, injected } = harness();
  assert.equal(await runCli(["publish"], injected), 1);
  assert.match(err.join("\n"),
    /^Usage: create \| update \| get \| delete \| purge \| labels \| move \| space \| children \| related \| context \| orphans \| stitch \| selftest$/m);
  assert.deepEqual(calls, []);
});

test(`${BROKER} never prints the secret or the bearer token`, async () => {
  const runs: string[][] = [
    ["create", "--space", "KB", "--title", "T", "--body", "x", "--format", "storage"],
    ["get", "--id", "5001"],
    ["update", "--id", "5001", "--body", "x", "--format", "wiki"],
    ["delete", "--id", "5001"],
    ["labels", "--id", "5001", "--labels", "alpha"],
    ["move", "--id", "5001", "--parent", "7001"],
    ["space", "--space", "KB"],
    ["children", "--id", "5001"],
    ["selftest"],
    ["get", "--id", "nope"],
  ];
  for (const argv of runs) {
    const { printed, injected } = harness({ api: defaultApi });
    await runCli(argv, injected);
    const text = printed();
    assert.doesNotMatch(text, new RegExp(CLIENT_SECRET), `${argv[0]} printed the secret`);
    assert.doesNotMatch(text, new RegExp(ACCESS_TOKEN), `${argv[0]} printed the token`);
    assert.doesNotMatch(text, new RegExp(CRED_PATH), `${argv[0]} printed the credential path`);
  }
});

test(`${BROKER} selftest resolves the cloudId and reports the token length only`, async () => {
  const { out, injected } = harness({
    api: (call) => (call.url.endsWith("/wiki/rest/api/user/current")
      ? response(200, { accountId: AUTHOR, displayName: "Service Account" })
      : response(200, {})),
  });
  // Two identical token answers cannot discriminate a tampered secret, so the
  // verdict is UNKNOWN and the exit code says so.
  assert.equal(await runCli(["selftest"], injected), 1);
  const text = out.join("\n");
  assert.match(text, new RegExp(`length ${ACCESS_TOKEN.length}`));
  assert.match(text, new RegExp(`cloudId: ${CLOUD_ID}`));
  assert.match(text, new RegExp(`account: ${AUTHOR} \\(Service Account\\)`));
  assert.doesNotMatch(text, new RegExp(ACCESS_TOKEN));
});

test(`${BROKER} update sends the version it read`, async () => {
  const { calls, injected } = harness({
    api: (call) => (call.options?.method === "GET"
      ? response(200, { ...PAGE, version: { number: 4 } })
      : response(200, { ...PAGE, version: { number: 5 } })),
  });
  assert.equal(await runCli(
    ["update", "--id", "5001", "--body", "x", "--format", "storage", "--version", "99"],
    injected,
  ), 0);
  const put = calls.find((call) => call.options?.method === "PUT");
  assert.ok(put);
  const body = JSON.parse(String(put.options?.body)) as { version: { number: number } };
  assert.equal(body.version.number, 5, "the caller's --version must be ignored");
});

// OP-1419. The re-parenting verb. `movePage` had existed and been covered since
// OP-1409 with no caller able to reach it, so these two cases are the first
// that go through a command line at all.
function moveApi(target: string, atTarget: unknown[]) {
  return (call: Call): HttpResponse => {
    if (call.url.includes("/wiki/api/v2/pages/5001?body-format=storage")) {
      return response(200, { ...PAGE, parentId: "4000", body: { storage: { value: "<p>unchanged</p>" } } });
    }
    if (call.url.includes(`/wiki/api/v2/pages/${target}/children`)) return response(200, { results: atTarget });
    if (call.options?.method === "PUT") return response(200, { ...PAGE, version: { number: 2 } });
    return response(200, {});
  };
}

test(`${BROKER} moves a page and proves it from the target's own child list`, async () => {
  const { out, calls, injected } = harness({ api: moveApi("7001", [{ id: "5001", title: "New page" }]) });
  assert.equal(await runCli(["move", "--id", "5001", "--parent", "7001"], injected), 0);
  const put = calls.find((call) => call.options?.method === "PUT");
  assert.ok(put, "no move was sent");
  const body = JSON.parse(String(put.options?.body)) as { parentId: string; body: { value: string } };
  assert.equal(body.parentId, "7001");
  assert.equal(body.body.value, "<p>unchanged</p>", "the body that was read goes back unchanged");
  assert.match(out.join("\n"), /^from parent: 4000$/m);
  assert.match(out.join("\n"), /^readback parent: 7001$/m);
  // The evidence is a SEPARATE read of the target, not the answer to the write.
  assert.ok(calls.some((call) => call.options?.method === "GET" && call.url.includes("/pages/7001/children")));
});

test(`${BROKER} reports a move it cannot see at the target as UNVERIFIED`, async () => {
  const { err, out, injected } = harness({ api: moveApi("7001", [{ id: "6002", title: "Elsewhere" }]) });
  assert.equal(await runCli(["move", "--id", "5001", "--parent", "7001"], injected), 1);
  assert.match(err.join("\n"), /UNVERIFIED/);
  assert.doesNotMatch(out.join("\n"), /readback parent/);
});

// OP-1436. The labels verb could only add, so a wrong evidence or session label
// could not be corrected without leaving two contradicting labels on the page.
function labelApi(after: string[]) {
  return (call: Call): HttpResponse => {
    if (call.options?.method === "DELETE") return response(204, null);
    if (call.url.includes("/pages/5001/labels")) return response(200, { results: after.map((name) => ({ name })) });
    return response(200, { results: [] });
  };
}

test(`${BROKER} removes labels and proves it from a separate read of the page's labels`, async () => {
  const { out, calls, injected } = harness({ api: labelApi(["type-observation", "evidence-assumed"]) });
  assert.equal(await runCli(["labels", "--id", "5001", "--remove", "evidence-confirmed"], injected), 0);
  const deletes = calls.filter((call) => call.options?.method === "DELETE");
  assert.deepEqual(deletes.map((call) => call.url.replace(/^.*\/wiki/, "/wiki")),
    ["/wiki/rest/api/content/5001/label?name=evidence-confirmed"]);
  assert.ok(!calls.some((call) => call.options?.method === "POST" && call.url.includes("/label")),
    "a pure removal must not post the runtime label");
  assert.match(out.join("\n"), /^labels: type-observation, evidence-assumed$/m);
});

test(`${BROKER} removes first, then adds, when both are given`, async () => {
  const { calls, injected } = harness({ api: labelApi(["type-observation"]) });
  assert.equal(await runCli(["labels", "--id", "5001", "--remove", "evidence-confirmed", "--labels", "evidence-assumed"], injected), 0);
  const writes = calls.filter((call) => call.options?.method === "DELETE" || call.options?.method === "POST")
    .filter((call) => call.url.includes("/label"));
  assert.deepEqual(writes.map((call) => call.options?.method), ["DELETE", "POST"]);
});

test(`${BROKER} fails when a removed label is still on the page afterwards`, async () => {
  const { err, injected } = harness({ api: labelApi(["evidence-confirmed"]) });
  assert.equal(await runCli(["labels", "--id", "5001", "--remove", "evidence-confirmed"], injected), 1);
  assert.match(err.join("\n"), /still present: evidence-confirmed/);
});

test(`${BROKER} refuses to remove the runtime label before sending anything`, async () => {
  const { err, calls, injected } = harness({ api: labelApi([]) });
  assert.equal(await runCli(["labels", "--id", "5001", "--remove", "runtime-claude-code-win"], injected), 1);
  assert.ok(!calls.some((call) => call.url.includes("/label")), "no label request may be sent");
  assert.match(err.join("\n"), /runtime label/);
});
