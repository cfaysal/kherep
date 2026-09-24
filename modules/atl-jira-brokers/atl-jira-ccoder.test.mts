import test from "node:test";
import assert from "node:assert/strict";
import { readFile as nodeReadFile } from "node:fs/promises";

import {
  adf,
  parseArgs,
  parseCredentialText,
  runCli,
  selectTransition,
  type BrokerContext,
  type HttpResponse,
  type RequestOptions,
} from "./atl-jira-ccoder.mts";

// Eine aufgezeichnete Anfrage. Der Broker schickt zu jedem Aufruf Optionen mit;
// der Ersatz unten macht das fuer den Typ sichtbar, ohne die Aufzeichnung zu
// veraendern - ein fehlender Body faellt am JSON.parse der Assertion auf.
interface RecordedCall {
  url: string;
  options: RequestOptions;
}

// Die Antworten des Fakes, nach Endpunkt getrennt: api beantwortet die
// fachlichen Aufrufe in ihrer Reihenfolge, token den Auth-Endpunkt und weiss
// dabei, ob das Secret verfaelscht ankam.
interface Handler {
  api: (step: number, url?: string, options?: RequestOptions) => HttpResponse;
  token?: (tampered: boolean) => HttpResponse;
}

interface Harness {
  out: string[];
  err: string[];
  // OP-1396. Bytes the broker sent to stdout, captured instead of printed.
  outBytes: Buffer[];
  calls: RecordedCall[];
  api: RecordedCall[];
  counters: { credentialReads: number };
  // OP-1396. What readBytes may answer. Nothing is on disk: a test that reached
  // the real filesystem would pass or fail for reasons that have nothing to do
  // with the broker.
  files: Map<string, Buffer>;
  injected: Partial<BrokerContext>;
}

const NO_REQUEST: RequestOptions = { method: "", headers: {} };

const CLIENT_ID = "client-id-for-tests";
const CLIENT_SECRET = "secret-for-tests-1234";
const ACCESS_TOKEN = "access-token-must-not-be-reported";
const CLOUD_ID = "cloud-id-for-tests";
const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = `Client ID: ${CLIENT_ID}\nSecret: ${CLIENT_SECRET}\n`;
const ACCEPTANCE = "jira-comment:14804";
const JIRA_ENV = {
  KHEREP_ATL_SITE: "https://jira.example.com",
  KHEREP_ATL_PROJECT_ID: "20202",
  KHEREP_ATL_PROJECT_KEY: "OP",
  KHEREP_ATL_ISSUE_TYPES: JSON.stringify({
    Epic: "31000", Story: "31001", Task: "31002", "Sub-task": "31003", Bug: "31004",
  }),
};

const doneCommand = () => [
  "transition", "--key", "OP-999", "--to", "done", "--acceptance", ACCEPTANCE,
];

// OP-1396. A stub that can answer a BODY OF BYTES. jsonResponse deliberately
// cannot: the download path must not be satisfiable by a stub that only knows
// how to be text.
function bytesResponse(status: number, bytes: Buffer): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return {}; },
    async text() { return bytes.toString("utf8"); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; },
  };
}

function jsonResponse(status: number, payload?: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload ?? {}; },
    async text() { return payload === undefined ? "" : JSON.stringify(payload); },
  };
}

// Faengt jede Ausgabe ab, damit der Test sie pruefen kann und damit kein
// Testlauf ungewollt auf die Konsole schreibt.
//
// Der Handler wird nach URL geroutet und nicht nach Aufrufnummer: wie viele
// Token- und tenant_info-Requests ein Kommando ausloest, ist genau das, was
// der Session-Cache veraendert, und darf deshalb nicht in der Indexierung der
// Erwartungen stecken.
//
// Der Default liefert expires_in 3600 wie der echte Endpunkt (belegt in
// OP-809). Ohne dieses Feld cached der Broker bewusst nicht, ein Fake ohne
// expires_in wuerde also still das Gegenteil dessen messen, was er soll.
function harness(
  handler: Handler,
  env: Record<string, string | undefined> = { KHEREP_ATL_CRED_FILE_CLAUDE: CRED_PATH },
  opts: { tty?: boolean } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  // OP-1396. Bytes that WOULD have gone to stdout. Captured rather than written:
  // a test that let the broker reach the real stdout would print an attachment
  // into the test report.
  const outBytes: Buffer[] = [];
  const calls: RecordedCall[] = [];
  const api: RecordedCall[] = [];
  const counters = { credentialReads: 0 };
  const files = new Map<string, Buffer>();
  return {
    out,
    err,
    outBytes,
    calls,
    api,
    counters,
    files,
    injected: {
      writeOut: (chunk: Buffer) => { outBytes.push(chunk); },
      stdoutIsTty: () => opts.tty === true,
      env: { ...JIRA_ENV, ...env },
      readFile: async (path: string) => {
        counters.credentialReads += 1;
        if (path === CRED_PATH) return CRED_TEXT;
        throw new Error("not readable");
      },
      readBytes: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error("not readable");
        return bytes;
      },
      fetch: async (url, options) => {
        calls.push({ url, options: options ?? NO_REQUEST });
        if (String(url).includes("oauth/token")) {
          const tampered = JSON.parse(Buffer.from(options?.body ?? []).toString("utf8")).client_secret !== CLIENT_SECRET;
          return handler.token
            ? handler.token(tampered)
            : jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
        }
        if (String(url).includes("_edge/tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
        api.push({ url, options: options ?? NO_REQUEST });
        return handler.api(api.length, url, options);
      },
      log: (line: string) => { out.push(String(line)); },
      logError: (line: string) => { err.push(String(line)); },
    },
  };
}

function sentBody(call: RecordedCall) {
  return JSON.parse(Buffer.from(call.options.body ?? []).toString("utf8"));
}

function assertNoSecretsLeaked({ out, err }: { out: string[]; err: string[] }): void {
  const all = [...out, ...err].join("\n");
  for (const secret of [CLIENT_SECRET, ACCESS_TOKEN, CRED_PATH, CLIENT_ID]) {
    assert.equal(all.includes(secret), false, `Ausgabe enthaelt ${secret}`);
  }
}

test("parseCredentialText accepts both orderings and rejects malformed credentials", () => {
  for (const credentials of [
    `Secret: ${CLIENT_SECRET}\nClient ID: ${CLIENT_ID}\n`,
    `Client ID: ${CLIENT_ID}\nSecret: ${CLIENT_SECRET}\n`,
  ]) assert.deepEqual(parseCredentialText(credentials), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  for (const malformed of [
    `Client ID: ${CLIENT_ID}\n`,
    `Client ID: ${CLIENT_ID}\nSecret: ${CLIENT_SECRET}\nExtra: value\n`,
    "Secret: first\nOther Secret: second\n",
  ]) assert.throws(() => parseCredentialText(malformed));
});

test("unexpected fetch failures never expose their error message", async () => {
  const sentinel = "REGRESSION_SENTINEL_PRIVATE";
  const h = harness({ api: () => { throw new Error(sentinel); } });
  assert.equal(await runCli(["get", "--key", "OP-1"], h.injected), 1);
  assert.equal(h.err.join("\n").includes(sentinel), false);
  assert.deepEqual(h.err, ["Interner Fehler."]);
});

test("wrong-project keys for commands and links fail before fetch", async () => {
  const commands = [
    ["update", "--key", "OTHER-1", "--summary", "x"],
    ["comment", "--key", "OTHER-1", "--body", "x"],
    ["get", "--key", "OTHER-1"],
    ["transition", "--key", "OTHER-1", "--to", "in-progress"],
    ["link", "--type", "Duplicate", "--outward", "OTHER-1", "--inward", "OP-2"],
    ["unlink", "--type", "Duplicate", "--outward", "OP-1", "--inward", "OTHER-2"],
  ];
  for (const argv of commands) {
    const h = harness({ api: () => jsonResponse(200) });
    assert.equal(await runCli(argv, h.injected), 1);
    assert.equal(h.calls.length, 0);
  }
});

test("create refuses a returned key from another project", async () => {
  const h = harness({ api: () => jsonResponse(201, { key: "OTHER-1" }) });
  assert.equal(await runCli(["create", "--type", "Task", "--summary", "x", "--body", "x"], h.injected), 1);
  assert.equal(h.api.some((call) => call.url.includes("/issue/OTHER-1")), false);
});

test("adf splits on blank lines and keeps single newlines inside a paragraph", () => {
  assert.deepEqual(adf("eins\nzwei\n\ndrei").content, [
    { type: "paragraph", content: [{ type: "text", text: "eins zwei" }] },
    { type: "paragraph", content: [{ type: "text", text: "drei" }] },
  ]);
});

test("parseArgs reads flag value pairs and ignores stray positionals", () => {
  assert.deepEqual(parseArgs(["--key", "OP-1", "noise", "--to", "done"]), { key: "OP-1", to: "done" });
});

const LOCALISED_TRANSITIONS = [
  { id: "11", name: "待办", to: { id: "10024", name: "待办", statusCategory: { key: "new" } } },
  { id: "21", name: "正在进行", to: { id: "3", name: "正在进行", statusCategory: { key: "indeterminate" } } },
  { id: "31", name: "完成", to: { id: "10002", name: "完成", statusCategory: { key: "done" } } },
];

test("selectTransition resolves by category regardless of display language", () => {
  assert.equal(selectTransition(LOCALISED_TRANSITIONS, "done").selected?.id, "31");
});

test("selectTransition rejects transition ids and display names", () => {
  assert.deepEqual(selectTransition(LOCALISED_TRANSITIONS, "11"), {});
  assert.deepEqual(selectTransition(LOCALISED_TRANSITIONS, "正在进行"), {});
});

test("selectTransition reports an ambiguous category instead of guessing", () => {
  const { selected, ambiguous } = selectTransition(
    [
      { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
      { id: "41", name: "Rejected", to: { statusCategory: { key: "done" } } },
    ],
    "done",
  );
  assert.equal(selected, undefined);
  assert.deepEqual(ambiguous?.map(({ id }) => id), ["31", "41"]);
});

test("a missing credential variable fails before any network call", async () => {
  const h = harness({ api: () => jsonResponse(200, {}) }, {});
  assert.equal(await runCli(["get", "--key", "OP-1"], h.injected), 1);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.err, ["KHEREP_ATL_CRED_FILE_CLAUDE ist nicht gesetzt."]);
});

test("the Codex credential variable is ignored when the Claude variable is missing", async () => {
  const h = harness({ api: () => jsonResponse(200, {}) }, {
    KHEREP_ATL_CRED_FILE_CODEX: CRED_PATH,
    KHEREP_ATL_CRED_FILE: CRED_PATH,
    OTHER_VENDOR_ATL_CRED_FILE: CRED_PATH,
  });
  assert.equal(await runCli(["get", "--key", "OP-1"], h.injected), 1);
  assert.equal(h.calls.length, 0);
});

test("an unknown command is rejected before authentication", async () => {
  const h = harness({ api: () => jsonResponse(200, {}) });
  assert.equal(await runCli(["destroy"], h.injected), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.err[0], /^Nutzung: create \| update \| comment \| attach \| download \| get \| search \| transition \| link \| unlink \| selftest$/);
});

test("Done without a valid acceptance marker fails before credentials and every request", async () => {
  for (const args of [
    ["transition", "--key", "OP-999", "--to", "done"],
    ["transition", "--key", "OP-999", "--to", "done", "--acceptance", "jira-comment:0"],
  ]) {
    const h = harness({ api: () => { throw new Error("request must not run"); } });
    assert.equal(await runCli(args, h.injected), 1);
    assert.equal(h.counters.credentialReads, 0);
    assert.equal(h.calls.length, 0);
  }
});

test("free-form transition selectors fail before credentials and every request", async () => {
  for (const target of ["31", "In Progress", "完成"]) {
    const h = harness({ api: () => { throw new Error("request must not run"); } });
    assert.equal(await runCli(["transition", "--key", "OP-999", "--to", target], h.injected), 1);
    assert.equal(h.counters.credentialReads, 0);
    assert.equal(h.calls.length, 0);
  }
});

test("create sends UTF-8 ADF and reports the new key", async () => {
  const h = harness({ api: () => jsonResponse(201, { key: "OP-999" }) });
  assert.equal(await runCli(["create", "--summary", "Grösse", "--body", "Übergrösse"], h.injected), 0);
  const sent = sentBody(h.api[0]);
  assert.equal(sent.fields.summary, "Grösse");
  assert.deepEqual(sent.fields.description.content[0].content[0].text, "Übergrösse");
  assert.deepEqual(sent.fields.project, { id: "20202" });
  assert.deepEqual(sent.fields.issuetype, { id: "31002" });
  assert.equal(h.calls.find((call) => call.url.includes("_edge/tenant_info"))?.url,
    "https://jira.example.com/_edge/tenant_info");
  assert.deepEqual(h.out, ["status: 201", "key: OP-999"]);
  assertNoSecretsLeaked(h);
});

// OP-1124: Sub-task-Gleichstand mit dem Codex-Broker. Ein Sub-task ohne
// Elternvorgang ist kein Sub-task, also fällt der Aufruf vor dem Netz. Und ein
// 201 belegt nur, dass der Vorgang existiert, nicht dass er dort hängt, wo er
// hängen sollte (golden rule 13), deshalb wird der Elternvorgang nachgelesen.
test("Sub-task create sends the parent field and confirms it in the readback", async () => {
  const h = harness({ api: (n) => n === 1
    ? jsonResponse(201, { key: "OP-1000" })
    : jsonResponse(200, { key: "OP-1000", fields: { parent: { key: "OP-999" } } }) });
  assert.equal(await runCli([
    "create", "--type", "Sub-task", "--parent", "op-999", "--summary", "Child", "--body", "Body",
  ], h.injected), 0);
  assert.deepEqual(sentBody(h.api[0]).fields.parent, { key: "OP-999" });
  assert.match(h.api[1].url, /\?fields=parent$/);
  assert.deepEqual(h.out, ["status: 201", "key: OP-1000", "parent danach: OP-999"]);
  assert.deepEqual(h.err, []);
  assertNoSecretsLeaked(h);
});

test("a Sub-task without a parent fails before any network call", async () => {
  const h = harness({ api: () => { throw new Error("request must not run"); } });
  assert.equal(await runCli([
    "create", "--type", "Sub-task", "--summary", "Child", "--body", "Body",
  ], h.injected), 1);
  assert.equal(h.counters.credentialReads, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.err, ["--parent fehlt."]);
});

test("a parent that is not an OP key fails before any network call", async () => {
  const h = harness({ api: () => { throw new Error("request must not run"); } });
  assert.equal(await runCli([
    "create", "--type", "Sub-task", "--parent", "PROJ-1", "--summary", "Child", "--body", "Body",
  ], h.injected), 1);
  assert.equal(h.counters.credentialReads, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.err, ["--parent gehört nicht zum konfigurierten Jira-Projekt."]);
});

test("a parent on any other type fails before any network call", async () => {
  const h = harness({ api: () => { throw new Error("request must not run"); } });
  assert.equal(await runCli([
    "create", "--type", "Task", "--parent", "OP-999", "--summary", "Child", "--body", "Body",
  ], h.injected), 1);
  assert.equal(h.counters.credentialReads, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.err, ["--parent ist nur für Sub-task erlaubt."]);
});

test("a Sub-task create fails when the readback shows a different parent", async () => {
  const h = harness({ api: (n) => n === 1
    ? jsonResponse(201, { key: "OP-1000" })
    : jsonResponse(200, { key: "OP-1000", fields: { parent: { key: "OP-1" } } }) });
  assert.equal(await runCli([
    "create", "--type", "Sub-task", "--parent", "OP-999", "--summary", "Child", "--body", "Body",
  ], h.injected), 1);
  assert.match(h.err.join("\n"), /erwartet OP-999, gelesen OP-1/);
});

test("a Sub-task with an assignee reads parent and assignee back in one request", async () => {
  const h = harness({ api: (n) => n === 1
    ? jsonResponse(201, { key: "OP-1000" })
    : jsonResponse(200, {
      key: "OP-1000",
      fields: { parent: { key: "OP-999" }, assignee: { accountId: "account-1" } },
    }) });
  assert.equal(await runCli([
    "create", "--type", "Sub-task", "--parent", "OP-999", "--assignee", "account-1",
    "--summary", "Child", "--body", "Body",
  ], h.injected), 0);
  assert.equal(h.api.length, 2);
  assert.match(h.api[1].url, /\?fields=parent,assignee$/);
  assert.deepEqual(h.out.slice(-2), ["parent danach: OP-999", "assignee danach: account-1"]);
});

test("transition resolves a category and confirms the reached status by id", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, { transitions: LOCALISED_TRANSITIONS });
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { status: { id: "10002", name: "完成" } } });
  } });
  assert.equal(await runCli(doneCommand(), h.injected), 0);
  assert.deepEqual(sentBody(h.api[1]), {
    transition: { id: "31" },
    update: {
      comment: [{
        add: {
          body: {
            type: "doc",
            version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Done-Transition durch Kherep Jira-Service-Account-Broker." }] },
              { type: "paragraph", content: [{ type: "text", text: `Abnahmebeleg: ${ACCEPTANCE}` }] },
            ],
          },
        },
      }],
    },
  });
  assert.deepEqual(h.err, []);
  assertNoSecretsLeaked(h);
});

test("a non-Done category needs no acceptance marker", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, { transitions: LOCALISED_TRANSITIONS });
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { status: { id: "3", name: "正在进行" } } });
  } });
  assert.equal(await runCli([
    "transition", "--key", "OP-999", "--to", "indeterminate",
  ], h.injected), 0);
  assert.deepEqual(sentBody(h.api[1]), { transition: { id: "21" } });
});

test("transition serializes a numeric Jira transition id as a string", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, {
      transitions: [{
        id: 21,
        name: "In Progress",
        to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
      }],
    });
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { status: { id: "3", name: "In Progress" } } });
  } });
  assert.equal(await runCli([
    "transition", "--key", "OP-999", "--to", "indeterminate",
  ], h.injected), 0);
  assert.deepEqual(sentBody(h.api[1]), { transition: { id: "21" } });
});

// Der eigentliche Grund fuer diese Datei: vorher wurde der Readback nur
// gedruckt. Ein Wechsel auf ein falsches Ziel sah aus wie ein Erfolg.
test("transition fails when the readback lands on a different status", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, { transitions: LOCALISED_TRANSITIONS });
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { status: { id: "3", name: "In Progress" } } });
  } });
  assert.equal(await runCli(doneCommand(), h.injected), 1);
  assert.match(h.err.join("\n"), /erwartet Status-ID 10002, gelesen 3/);
});

test("transition fails when the readback itself does not load", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, { transitions: LOCALISED_TRANSITIONS });
    if (n === 2) return jsonResponse(204);
    return jsonResponse(404, { errorMessages: ["Issue does not exist"] });
  } });
  assert.equal(await runCli(doneCommand(), h.injected), 1);
  assert.match(h.err.join("\n"), /Readback nach dem Statuswechsel fehlgeschlagen/);
});

test("an ambiguous category aborts without writing anything", async () => {
  const h = harness({ api: () => jsonResponse(200, {
    transitions: [
      { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
      { id: "41", name: "Rejected", to: { name: "Rejected", statusCategory: { key: "done" } } },
    ],
  }) });
  assert.equal(await runCli(doneCommand(), h.injected), 1);
  assert.equal(h.api.length, 1, "nur die Transitions-Abfrage, also kein Schreibvorgang");
  assert.match(h.err[0], /trifft mehrere Uebergaenge: 31 Done, 41 Rejected/);
});

test("update confirms the new summary and fails when the readback disagrees", async () => {
  const ok = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "neu" } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--summary", "neu"], ok.injected), 0);

  const bad = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "alt" } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--summary", "neu"], bad.injected), 1);
  assert.match(bad.err.join("\n"), /Readback bestaetigt die neue Summary nicht/);
});

test("a description-only update says the readback did not confirm it", async () => {
  const h = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "unveraendert" } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--body", "text"], h.injected), 0);
  assert.match(h.out.join("\n"), /nicht durch Vergleich bestaetigt/);
});

test("selftest passes only when a tampered secret is actually rejected", async () => {
  const discriminating = harness({
    api: () => jsonResponse(200, {}),
    token: (tampered) => (tampered
      ? jsonResponse(401, { error: "access_denied" })
      : jsonResponse(200, { access_token: ACCESS_TOKEN })),
  });
  assert.equal(await runCli(["selftest"], discriminating.injected), 0);
  assert.match(discriminating.out.join("\n"), /verdikt: PASS/);
  assertNoSecretsLeaked(discriminating);

  const blind = harness({
    api: () => jsonResponse(200, {}),
    token: () => jsonResponse(200, { access_token: ACCESS_TOKEN }),
  });
  assert.equal(await runCli(["selftest"], blind.injected), 1);
  assert.match(blind.out.join("\n"), /verdikt: UNBEKANNT/);
});

// OP-1415. Paritaet mit dem Codex-Broker. "Diskriminiert nicht" hat zwei sehr
// verschiedene Gruende, und nur einer davon ist unentschieden. Wer beide in ein
// UNBEKANNT wirft, meldet ein bewiesenes Nein als "nichts gewusst".
test("selftest trennt einen Test, der nichts erkennt, von einem abgelehnten Secret", async () => {
  // Ein rotiertes oder widerrufenes Secret: beide Werte werden GLEICH abgelehnt.
  // Der Test kann sie nicht auseinanderhalten und weiss damit nichts.
  const rotated = harness({
    api: () => jsonResponse(200, {}),
    token: () => jsonResponse(401, { error: "access_denied" }),
  });
  assert.equal(await runCli(["selftest"], rotated.injected), 1);
  assert.match(rotated.out.join("\n"), /verdikt: UNBEKANNT/);
  assertNoSecretsLeaked(rotated);

  // Verschiedene Antworten: die Gegenstelle KANN die beiden unterscheiden, und
  // abgelehnt hat sie das echte Secret. Das ist ein Nein, kein Nichtwissen.
  const refused = harness({
    api: () => jsonResponse(200, {}),
    token: (tampered) => jsonResponse(401, { error: tampered ? "access_denied" : "invalid_client" }),
  });
  assert.equal(await runCli(["selftest"], refused.injected), 1);
  assert.match(refused.out.join("\n"), /verdikt: FEHLSCHLAG/);
  assertNoSecretsLeaked(refused);
});

// --- Session-Cache: pro Lauf, nur im Speicher, ablaufbewusst -----------------

const TRANSITION_FLOW = (n: number): HttpResponse => {
  if (n === 1) return jsonResponse(200, { transitions: LOCALISED_TRANSITIONS });
  if (n === 2) return jsonResponse(204);
  return jsonResponse(200, { fields: { status: { id: "10002", name: "完成" } } });
};

function tokenCounter(h: Harness): number {
  return h.calls.filter(({ url }) => String(url).includes("oauth/token")).length;
}
function tenantCounter(h: Harness): number {
  return h.calls.filter(({ url }) => String(url).includes("_edge/tenant_info")).length;
}

test("one run authenticates once, no matter how many Jira calls it makes", async () => {
  const h = harness({ api: TRANSITION_FLOW });
  assert.equal(await runCli(doneCommand(), h.injected), 0);
  assert.equal(h.api.length, 3, "drei fachliche Aufrufe");
  assert.equal(tokenCounter(h), 1, "genau ein Token-Request");
  assert.equal(tenantCounter(h), 1, "genau ein tenant_info-Request");
});

// Der Grund, warum der Cache am ctx haengt und nicht am Modul: zwei Laeufe
// duerfen sich niemals einen Token teilen, sonst schriebe der zweite unter der
// Identitaet des ersten und saehe dabei korrekt aus.
test("two separate runs never share a token", async () => {
  const first = harness({ api: TRANSITION_FLOW });
  const second = harness({ api: TRANSITION_FLOW });
  await runCli(doneCommand(), first.injected);
  await runCli(doneCommand(), second.injected);
  assert.equal(tokenCounter(first), 1);
  assert.equal(tokenCounter(second), 1, "der zweite Lauf holt seinen eigenen Token");
});

test("a run with a different credential environment authenticates on its own", async () => {
  const shared = { KHEREP_ATL_CRED_FILE_CLAUDE: CRED_PATH };
  const a = harness({ api: TRANSITION_FLOW }, shared);
  const b = harness({ api: TRANSITION_FLOW }, { ...shared });
  await runCli(["get", "--key", "OP-1"], a.injected);
  await runCli(["get", "--key", "OP-1"], b.injected);
  assert.equal(tokenCounter(a), 1);
  assert.equal(tokenCounter(b), 1);
});

test("an expired token is fetched again instead of reused", async () => {
  let clock = 1_000_000;
  const h = harness({
    api: TRANSITION_FLOW,
    token: () => jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 1 }),
  });
  // expires_in 1s liegt unterhalb der Sicherheitsmarge, der Cache darf nicht greifen.
  h.injected.now = () => clock;
  assert.equal(await runCli(doneCommand(), h.injected), 0);
  assert.equal(tokenCounter(h), 3, "jeder Aufruf holt neu, weil die Restlaufzeit zu kurz ist");
});

test("a token without expires_in is never cached", async () => {
  const h = harness({
    api: TRANSITION_FLOW,
    token: () => jsonResponse(200, { access_token: ACCESS_TOKEN }),
  });
  assert.equal(await runCli(doneCommand(), h.injected), 0);
  assert.equal(tokenCounter(h), 3, "ohne belastbare Gueltigkeit lieber ein Request mehr");
});

test("selftest still sends both the real and the tampered secret", async () => {
  const h = harness({
    api: () => jsonResponse(200, {}),
    token: (tampered) => (tampered
      ? jsonResponse(401, { error: "access_denied" })
      : jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3600 })),
  });
  assert.equal(await runCli(["selftest"], h.injected), 0);
  assert.equal(tokenCounter(h), 2, "der Kontroll-Lauf darf nicht vom Cache verschluckt werden");
});

// Statische Zusicherung: der Cache darf niemals auf Platte wandern. Eine
// Token-Datei laege ausserhalb des privacy-boundary-guard, der nur den
// Credentials-Pfad deckt, und waere bis zu eine Stunde gueltig.
test("the broker imports no write API and can therefore not persist a token", async () => {
  const source = await nodeReadFile(new URL("./atl-jira-ccoder.mts", import.meta.url), "utf8");
  assert.match(source, /import \{ readFile as nodeReadFile \} from "node:fs\/promises";/);
  for (const forbidden of ["writeFile", "appendFile", "createWriteStream", "writeFileSync", "mkdir"]) {
    assert.equal(source.includes(forbidden), false, `Broker referenziert ${forbidden}`);
  }
});

test("comment reports the new comment id and fails on a non-201", async () => {
  const ok = harness({ api: () => jsonResponse(201, { id: "13848" }) });
  assert.equal(await runCli(["comment", "--key", "OP-999", "--body", "x"], ok.injected), 0);
  assert.deepEqual(ok.out, ["status: 201", "commentId: 13848"]);

  const denied = harness({ api: () => jsonResponse(403, { errorMessages: ["no"] }) });
  assert.equal(await runCli(["comment", "--key", "OP-999", "--body", "x"], denied.injected), 1);
  assert.deepEqual(denied.err, ["errorMessage: no"]);
});

// OP-963: --labels und --components. Die Belege, die ein gruener Test hier
// liefern muss, sind der GESENDETE Body und die Zahl der Schreib-Requests, nicht
// nur der Exitcode: ein Broker, der das Feld gar nicht sendet, und einer, der es
// korrekt sendet, haben denselben Exitcode.
const COMPONENT_CATALOG = [
  { id: "10100", name: "Broker" },
  { id: "10101", name: "Hooks" },
];

const writes = (h: Harness) => h.api.filter((call) => call.options.method === "PUT");

test("an update without the new flags touches neither labels nor components", async () => {
  const h = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "neu" } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--summary", "neu"], h.injected), 0);
  const sent = sentBody(h.api[0]).fields;
  assert.deepEqual(Object.keys(sent), ["summary"]);
  assert.match(h.api[1].url, /\?fields=summary$/);
});

test("an empty --labels clears the field and is sent as an empty array", async () => {
  const h = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "alt", labels: [] } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--labels", ""], h.injected), 0);
  assert.deepEqual(sentBody(h.api[0]).fields, { labels: [] });
  assert.match(h.api[1].url, /\?fields=summary,labels$/);
});

test("component names are resolved to ids and confirmed by the readback", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, COMPONENT_CATALOG);
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, {
      fields: { summary: "alt", components: [{ id: "10101" }, { id: "10100" }] },
    });
  } });
  assert.equal(await runCli(["update", "--key", "OP-999", "--components", "Broker, Hooks"], h.injected), 0);
  assert.match(h.api[0].url, /\/project\/20202\/components$/);
  assert.deepEqual(sentBody(h.api[1]).fields, { components: [{ id: "10100" }, { id: "10101" }] });
  assert.match(h.api[2].url, /\?fields=summary,components$/);
  assert.deepEqual(h.err, []);
});

// Der eigentliche Grund fuer die Aufloesung vor dem Schreiben: sonst waeren
// Summary und Labels geschrieben, waehrend Jira den Aufruf wegen der Komponente
// abweist. Belegt wird das an der Zahl der Schreib-Requests, nicht am Exitcode.
test("an unknown component name aborts before any write request goes out", async () => {
  const h = harness({ api: (n) => (
    n === 1 ? jsonResponse(200, COMPONENT_CATALOG) : jsonResponse(204)
  ) });
  assert.equal(await runCli([
    "update", "--key", "OP-999", "--summary", "neu", "--components", "Nirgends",
  ], h.injected), 1);
  assert.equal(writes(h).length, 0, "kein Schreib-Request");
  assert.equal(h.api.length, 1, "nur die Komponenten-Abfrage");
  assert.match(h.err.join("\n"), /Unbekannte Komponente: Nirgends/);
});

test("an unreadable component catalog aborts before any write request goes out", async () => {
  const h = harness({ api: () => jsonResponse(403, { errorMessages: ["No permission"] }) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--components", "Broker"], h.injected), 1);
  assert.equal(writes(h).length, 0, "kein Schreib-Request");
  assert.match(h.err.join("\n"), /Komponenten des Projekts sind nicht lesbar/);
});

test("update fails when the readback does not show the written labels", async () => {
  const h = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "alt", labels: ["eins"] } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--labels", "eins,zwei"], h.injected), 1);
  assert.match(h.err.join("\n"), /erwartet \[eins, zwei\], gelesen \[eins\]/);
});

test("update fails when the readback does not show the written components", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, COMPONENT_CATALOG);
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { summary: "alt", components: [] } });
  } });
  assert.equal(await runCli(["update", "--key", "OP-999", "--components", "Broker"], h.injected), 1);
  assert.match(h.err.join("\n"), /Komponenten nicht: erwartet \[10100\], gelesen \[\]/);
});

test("labels alone are enough to make an update, no summary required", async () => {
  const h = harness({ api: (n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "alt", labels: ["x"] } })
  ) });
  assert.equal(await runCli(["update", "--key", "OP-999", "--labels", "x"], h.injected), 0);
  assert.equal(h.out.includes("hinweis: Beschreibung wurde geschrieben, aber nicht durch Vergleich bestaetigt."), false);
});

test("an update without any field fails before authentication", async () => {
  const h = harness({ api: () => jsonResponse(204) });
  assert.equal(await runCli(["update", "--key", "OP-999"], h.injected), 1);
  assert.equal(h.calls.length, 0, "kein einziger Request, auch kein Token-Request");
  assert.match(h.err.join("\n"), /Nichts zu aendern/);
});

const LINK_TYPES = {
  issueLinkTypes: [
    { id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
    { id: "1010", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  ],
};
const LINKED = {
  fields: { issuelinks: [{
    id: "10501",
    type: { id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
    inwardIssue: { key: "OP-827" },
  }] },
};
const UNLINKED = { fields: { issuelinks: [] } };
const linkCommand = (name: string) => [name, "--type", "Duplicate", "--outward", "OP-1093", "--inward", "OP-827"];
const linkWrites = (h: Harness) => h.api.filter((call) => ["POST", "DELETE"].includes(call.options.method));

test("link resolves the type, sends both roles and confirms the link on the issue", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, LINK_TYPES);
    if (n === 2) return jsonResponse(201);
    return jsonResponse(200, LINKED);
  } });
  assert.equal(await runCli(linkCommand("link"), h.injected), 0);
  assert.match(h.api[0].url, /\/issueLinkType$/);
  assert.match(h.api[1].url, /\/issueLink$/);
  assert.deepEqual(sentBody(h.api[1]), {
    type: { id: "1000" },
    outwardIssue: { key: "OP-1093" },
    inwardIssue: { key: "OP-827" },
  });
  assert.match(h.api[2].url, /\/issue\/OP-1093\?fields=issuelinks$/);
  assert.equal(h.out.includes("verknüpfung: OP-1093 duplicates OP-827"), true);
  assert.equal(h.out.includes("linkId: 10501"), true);
  assert.deepEqual(h.err, []);
  assertNoSecretsLeaked(h);
});

test("an unknown link type aborts before any write request goes out", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(201) });
  assert.equal(await runCli(["link", "--type", "Duplicates", "--outward", "OP-1093", "--inward", "OP-827"], h.injected), 1);
  assert.equal(linkWrites(h).length, 0);
  assert.equal(h.api.length, 1);
  assert.match(h.err.join("\n"), /Unbekannter Verknüpfungstyp: Duplicates/);
  assert.match(h.err.join("\n"), /Duplicate, Blocks/);
});

test("an unreadable link type catalog aborts before any write request goes out", async () => {
  const h = harness({ api: () => jsonResponse(403, { errorMessages: ["No permission"] }) });
  assert.equal(await runCli(linkCommand("link"), h.injected), 1);
  assert.equal(linkWrites(h).length, 0);
  assert.match(h.err.join("\n"), /Verknüpfungstypen der Site sind nicht lesbar/);
});

test("link and unlink without their mandatory flags fail before authentication", async () => {
  for (const argv of [
    ["link", "--outward", "OP-1093", "--inward", "OP-827"],
    ["link", "--type", "Duplicate", "--inward", "OP-827"],
    ["link", "--type", "Duplicate", "--outward", "OP-1093"],
    ["unlink", "--type", "Duplicate", "--outward", "OP-1093"],
    ["unlink", "--type", "Duplicate", "--outward", "OP-1093", "--inward", "kein-key"],
  ]) {
    const h = harness({ api: () => jsonResponse(200, LINK_TYPES) });
    assert.equal(await runCli(argv, h.injected), 1);
    assert.equal(h.calls.length, 0);
    assert.match(h.err.join("\n"), /fehlt\.|kein Vorgangsschlüssel/);
  }
});

test("link fails when the readback shows the pair linked the other way round", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, LINK_TYPES);
    if (n === 2) return jsonResponse(201);
    return jsonResponse(200, { fields: { issuelinks: [{ id: "10502", type: { id: "1000" }, outwardIssue: { key: "OP-827" } }] } });
  } });
  assert.equal(await runCli(linkCommand("link"), h.injected), 1);
  assert.match(h.err.join("\n"), /Readback bestätigt die Verknüpfung nicht/);
});

test("link fails when the readback itself does not load", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 2 ? jsonResponse(201) : jsonResponse(500, { errorMessages: ["boom"] }) });
  assert.equal(await runCli(linkCommand("link"), h.injected), 1);
  assert.match(h.err.join("\n"), /Readback nach dem Verknüpfen fehlgeschlagen/);
});

test("link reports a refused write and does not claim a readback", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(404, { errorMessages: ["issue linking is disabled"] }) });
  assert.equal(await runCli(linkCommand("link"), h.injected), 1);
  assert.equal(h.api.length, 2);
  assert.match(h.err.join("\n"), /issue linking is disabled/);
});

test("unlink reads the link id off the issue and confirms the removal", async () => {
  const h = harness({ api: (n) => {
    if (n === 1) return jsonResponse(200, LINK_TYPES);
    if (n === 2) return jsonResponse(200, LINKED);
    if (n === 3) return jsonResponse(204);
    return jsonResponse(200, UNLINKED);
  } });
  assert.equal(await runCli(linkCommand("unlink"), h.injected), 0);
  assert.equal(h.api[2].options.method, "DELETE");
  assert.match(h.api[2].url, /\/issueLink\/10501$/);
  assert.equal(h.out.includes("linkId: 10501"), true);
  assert.deepEqual(h.err, []);
});

test("unlink accepts the documented 200 as well as the 204", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 2 ? jsonResponse(200, LINKED) : n === 3 ? jsonResponse(200) : jsonResponse(200, UNLINKED) });
  assert.equal(await runCli(linkCommand("unlink"), h.injected), 0);
});

test("unlink deletes nothing when the issue carries no such link", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(200, UNLINKED) });
  assert.equal(await runCli(linkCommand("unlink"), h.injected), 1);
  assert.equal(linkWrites(h).length, 0);
  assert.match(h.err.join("\n"), /Keine passende Verknüpfung: OP-1093 duplicates OP-827/);
});

test("unlink refuses to pick when several links match", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(200, {
    fields: { issuelinks: [LINKED.fields.issuelinks[0], { ...LINKED.fields.issuelinks[0], id: "10502" }] },
  }) });
  assert.equal(await runCli(linkCommand("unlink"), h.injected), 1);
  assert.equal(linkWrites(h).length, 0);
  assert.match(h.err.join("\n"), /Mehrere passende Verknüpfungen: 10501, 10502/);
});

test("unlink fails when the readback still shows the link", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 3 ? jsonResponse(204) : jsonResponse(200, LINKED) });
  assert.equal(await runCli(linkCommand("unlink"), h.injected), 1);
  assert.match(h.err.join("\n"), /Readback zeigt die Verknüpfung weiterhin/);
});

test("unlink fails when the readback after the delete does not load", async () => {
  const h = harness({ api: (n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 2 ? jsonResponse(200, LINKED) : n === 3 ? jsonResponse(204) : jsonResponse(500, { errorMessages: ["boom"] }) });
  assert.equal(await runCli(linkCommand("unlink"), h.injected), 1);
  assert.match(h.err.join("\n"), /Readback nach dem Lösen fehlgeschlagen/);
});

// OP-1372. The module tests pin the query shape; these pin that the command
// actually reaches the site with it. A tested module behind an unwired verb is
// exactly the gap golden rule 13 is about.
test("search asks the supported route and reports the page it received", async () => {
  const h = harness({ api: () => jsonResponse(200, {
    isLast: false,
    nextPageToken: "tok-2",
    issues: [{ key: "OP-42", fields: { summary: "Ein Titel", status: { name: "To Do" } } }],
  }) });
  assert.equal(await runCli(["search", "--jql", "project = OP", "--max", "5"], h.injected), 0);
  const { url } = h.api[0];
  assert.ok(url.includes("/rest/api/3/search/jql?"), url);
  assert.equal(url.includes("/rest/api/3/search?"), false, "die abgeloeste Route darf nicht benutzt werden");
  const query = new URLSearchParams(url.split("?")[1]);
  assert.equal(query.get("jql"), "project = OP");
  assert.equal(query.get("maxResults"), "5");
  assert.equal(query.get("fields"), "summary,status,updated");
  assert.ok(h.out.includes("OP-42\tTo Do\tEin Titel"), h.out.join("|"));
  assert.ok(h.out.includes("count: 1"));
  assert.ok(h.out.includes("last: false"));
  assert.ok(h.out.includes("nextPageToken: tok-2"));
});

test("a continuation token is forwarded so a caller can read past page one", async () => {
  const h = harness({ api: () => jsonResponse(200, { isLast: true, issues: [] }) });
  assert.equal(await runCli(["search", "--jql", "project = OP", "--page", "tok-2"], h.injected), 0);
  assert.equal(new URLSearchParams(h.api[0].url.split("?")[1]).get("nextPageToken"), "tok-2");
  assert.ok(h.out.includes("last: true"));
});

test("a blank --jql names the argument instead of failing as an internal error", async () => {
  const h = harness({ api: () => jsonResponse(200, {}) });
  assert.equal(await runCli(["search", "--jql", "   "], h.injected), 1);
  assert.deepEqual(h.err, ["--jql fehlt."]);
  assert.equal(h.api.length, 0);
});

test("get honours --fields and an empty one keeps the defaults instead of asking for nothing", async () => {
  const chosen = harness({ api: () => jsonResponse(200, { key: "OP-7", fields: { summary: "T" } }) });
  assert.equal(await runCli(["get", "--key", "OP-7", "--fields", "summary"], chosen.injected), 0);
  assert.match(chosen.api[0].url, /\?fields=summary$/);
  assert.ok(chosen.out.includes("summary: T"));

  const blank = harness({ api: () => jsonResponse(200, { key: "OP-7", fields: {} }) });
  assert.equal(await runCli(["get", "--key", "OP-7", "--fields", ""], blank.injected), 0);
  assert.match(blank.api[0].url, /\?fields=summary,status,description,creator,attachment$/);
});

// OP-1387. Der Vorgang wurde gelesen, die Beschreibung aber weder angefordert
// noch gedruckt: ein Aufrufer konnte nicht erfahren, was der Vorgang sagt.
const DESCRIPTION_DOC = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Ziel" }] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "eins" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "zwei" }] }] },
    ] },
  ],
};

test("get prints the description as readable text", async () => {
  const h = harness({ api: () => jsonResponse(200, { key: "OP-7", fields: { summary: "T", description: DESCRIPTION_DOC } }) });
  assert.equal(await runCli(["get", "--key", "OP-7"], h.injected), 0);
  assert.match(h.api[0].url, /\?fields=summary,status,description,creator,attachment$/);
  assert.ok(h.out.includes("description:\n## Ziel\n\n- eins\n- zwei"), h.out.join(" | "));
});

test("get stays silent about a work item that has no description", async () => {
  for (const fields of [{ summary: "T" }, { summary: "T", description: null }]) {
    const h = harness({ api: () => jsonResponse(200, { key: "OP-7", fields }) });
    assert.equal(await runCli(["get", "--key", "OP-7"], h.injected), 0);
    assert.equal(h.out.some((line) => line.startsWith("description")), false, h.out.join(" | "));
  }
});

test("a description that renders to nothing is reported, not dropped", async () => {
  const h = harness({ api: () => jsonResponse(200, { key: "OP-7", fields: { description: { type: "doc", version: 1, content: [] } } }) });
  assert.equal(await runCli(["get", "--key", "OP-7"], h.injected), 0);
  assert.ok(h.out.includes("description: <vorhanden, aber nicht als Text darstellbar>"), h.out.join(" | "));
});

// OP-1396. Attach. Nothing here touches the network or the disk: the fake fetch
// records what the broker would have sent, which is the only thing a test can
// prove without the live acceptance the Director runs separately.
const ATTACH_FILE = "/nowhere/2026-09-18-design.md";
const ATTACH_BYTES = Buffer.from("# Design\n\nerste Zeile\n", "utf8");
const UPLOADED = [{ id: "10222", filename: "2026-09-18-design.md" }];

function attachHarness(
  upload: HttpResponse = jsonResponse(200, UPLOADED),
  readback: HttpResponse = jsonResponse(200, { key: "OP-7", fields: { attachment: UPLOADED } }),
): Harness {
  const h = harness({ api: (step) => (step === 1 ? upload : readback) });
  h.files.set(ATTACH_FILE, ATTACH_BYTES);
  return h;
}

test("attach posts multipart with the XSRF header and never application/json", async () => {
  const h = attachHarness();
  assert.equal(await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE], h.injected), 0);

  const sent = h.api[0];
  assert.match(sent.url, /\/rest\/api\/3\/issue\/OP-7\/attachments$/);
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.options.headers["X-Atlassian-Token"], "no-check");
  assert.match(sent.options.headers["Content-Type"], /^multipart\/form-data; boundary=----KherepFormBoundary/);
  assert.equal(sent.options.headers["Content-Type"].includes("application/json"), false);

  const body = Buffer.from(sent.options.body ?? []).toString("utf8");
  assert.match(body, /Content-Disposition: form-data; name="file"; filename="2026-09-18-design\.md"/);
  assert.match(body, /Content-Type: application\/octet-stream/);
  assert.ok(body.includes("# Design"));
  assert.equal(sent.options.headers["Content-Length"], String(Buffer.from(sent.options.body ?? []).length));

  assert.deepEqual(h.out, ["status: 200", "attachmentId: 10222", "filename: 2026-09-18-design.md"]);
  assert.deepEqual(h.err, []);
  assertNoSecretsLeaked(h);
});

test("attach uses the same token and cloudId as every other verb", async () => {
  const h = attachHarness();
  assert.equal(await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE], h.injected), 0);
  assert.equal(h.calls.filter((call) => call.url.includes("oauth/token")).length, 1);
  assert.equal(h.calls.filter((call) => call.url.includes("_edge/tenant_info")).length, 1);
  // The upload and the readback are one session, so they carry one Authorization.
  assert.equal(h.api[0].options.headers.Authorization, h.api[1].options.headers.Authorization);
  assert.equal(h.api[0].options.headers["Accept-Language"], "en-US");
});

test("attach reads the work item back instead of believing the upload answer", async () => {
  const h = attachHarness(
    jsonResponse(200, UPLOADED),
    jsonResponse(200, { key: "OP-7", fields: { attachment: [{ id: "99", filename: "other.md" }] } }),
  );
  assert.equal(await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE], h.injected), 1);
  assert.match(h.api[1].url, /\?fields=attachment$/);
  assert.match(h.err.join("\n"), /Readback bestaetigt den Anhang nicht/);
});

test("attach treats an answer that proves no attachment as a failure", async () => {
  for (const answer of [jsonResponse(200, []), jsonResponse(200, { id: "1" }), jsonResponse(201, UPLOADED)]) {
    const h = attachHarness(answer);
    assert.equal(await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE], h.injected), 1);
    assert.equal(h.api.length, 1, "a failed upload must not be read back as if it had worked");
  }
});

test("attach reports a 4xx from the endpoint without inventing a success", async () => {
  const h = attachHarness(jsonResponse(413, { errorMessages: ["The file is too large."] }));
  assert.equal(await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE], h.injected), 1);
  assert.ok(h.out.includes("status: 413"));
  assert.ok(h.err.includes("errorMessage: The file is too large."));
});

test("attach names the part content type explicitly and lets the caller override it", async () => {
  const h = attachHarness();
  assert.equal(
    await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE, "--content-type", "text/markdown"], h.injected),
    0,
  );
  assert.match(Buffer.from(h.api[0].options.body ?? []).toString("utf8"), /Content-Type: text\/markdown/);

  const bad = attachHarness();
  assert.equal(
    await runCli(["attach", "--key", "OP-7", "--file", ATTACH_FILE, "--content-type", "text/plain; charset=utf8"], bad.injected),
    1,
  );
  assert.equal(bad.calls.length, 0, "an invalid media type must fail before any network call");
});

test("attach fails closed on a missing or unreadable file and never names the path", async () => {
  const missing = attachHarness();
  assert.equal(await runCli(["attach", "--key", "OP-7", "--file", "/nowhere/absent.md"], missing.injected), 1);
  assert.deepEqual(missing.err, ["--file nicht lesbar."]);
  assert.equal(missing.err.join("\n").includes("/nowhere/absent.md"), false);

  const blank = attachHarness();
  assert.equal(await runCli(["attach", "--key", "OP-7", "--file", "   "], blank.injected), 1);
  assert.deepEqual(blank.err, ["--file fehlt."]);
  assert.equal(blank.calls.length, 0);
});

test("attach refuses a key from another project before any network call", async () => {
  const h = attachHarness();
  assert.equal(await runCli(["attach", "--key", "OTHER-1", "--file", ATTACH_FILE], h.injected), 1);
  assert.equal(h.calls.length, 0);
});

// OP-1396. The readback. The defect this closes: both brokers could upload a
// file and neither could read one back, so acceptance went around the broker.
const MD_BYTES = Buffer.from("# Handover\n\nZeile mit Ae, Oe, Ue und ss.\n", "utf8");
const MD_META = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: MD_BYTES.length };
const BIN_META = { id: "10223", filename: "notes.bin", mimeType: "application/octet-stream", size: 401 };

// A download starts at the work item's own attachment list, which is what makes
// --key bind: the metadata endpoint carries no issue reference at all.
function downloadHandler(entries: unknown[], bytes: Buffer, issueKey = "OP-1396") {
  return (_step: number, url?: string) => (String(url).includes("/attachment/content/")
    ? bytesResponse(200, bytes)
    : jsonResponse(200, { key: issueKey, fields: { attachment: entries } }));
}

test("download prints a text attachment to stdout and nothing else", async () => {
  const h = harness({ api: downloadHandler([MD_META], MD_BYTES) });
  assert.equal(await runCli(["download", "--key", "OP-1396", "--id", "10224"], h.injected), 0);
  // The whole point: stdout is the file, byte for byte, and carries no chrome.
  assert.equal(Buffer.concat(h.outBytes).toString("utf8"), MD_BYTES.toString("utf8"));
  assert.deepEqual(h.out, [], "stdout darf neben den Bytes nichts tragen");
  assert.deepEqual(h.err, []);
});

test("download reads the work item's list, then the content with redirect=false", async () => {
  const h = harness({ api: downloadHandler([MD_META], MD_BYTES) });
  assert.equal(await runCli(["download", "--key", "OP-1396", "--id", "10224"], h.injected), 0);
  // Two requests, the same count as before the key was validated: the list read
  // REPLACED the metadata read rather than being added to it.
  assert.equal(h.api.length, 2);
  assert.match(h.api[0].url, /\/rest\/api\/3\/issue\/OP-1396\?fields=attachment$/);
  assert.match(h.api[1].url, /\/rest\/api\/3\/attachment\/content\/10224\?redirect=false$/);
});

// One auth path per broker: the download must not mint a second token.
test("download reuses the one token and cloudId of the run", async () => {
  const h = harness({ api: downloadHandler([MD_META], MD_BYTES) });
  await runCli(["download", "--key", "OP-1396", "--id", "10224"], h.injected);
  assert.equal(h.calls.filter(({ url }) => String(url).includes("oauth/token")).length, 1);
  assert.equal(h.calls.filter(({ url }) => String(url).includes("tenant_info")).length, 1);
});

// THE REPORTED DEFECT. `download --key OP-1396 --id 10222` used to return the
// attachment of OP-1371 with exit 0, because --key was accepted and never read.
test("an attachment of another work item is refused, naming both values", async () => {
  const h = harness({ api: downloadHandler([MD_META], MD_BYTES) });
  assert.equal(await runCli(["download", "--key", "OP-1396", "--id", "10222"], h.injected), 1);
  assert.equal(h.outBytes.length, 0, "kein Byte darf den Broker verlassen");
  const said = h.err.join("\n");
  assert.match(said, /10222/, "die gesuchte id fehlt in der Meldung");
  assert.match(said, /OP-1396/, "der Vorgang fehlt in der Meldung");
  // Refused BEFORE the content request: the foreign file is never fetched.
  assert.equal(h.api.length, 1);
});

test("a key naming a work item that does not exist fails as a 404, not as a foreign file", async () => {
  const h = harness({ api: () => jsonResponse(404, { errorMessages: ["Issue does not exist"] }) });
  assert.equal(await runCli(["download", "--key", "OP-999999", "--id", "10222"], h.injected), 1);
  assert.equal(h.outBytes.length, 0);
  assert.match(h.err.join("\n"), /404|does not exist/);
});

test("download without a key is refused before any network call", async () => {
  const h = harness({ api: downloadHandler([MD_META], MD_BYTES) });
  assert.equal(await runCli(["download", "--id", "10224"], h.injected), 1);
  assert.equal(h.api.length, 0);
  assert.match(h.err.join("\n"), /--key/);
});

test("download without an id is refused before any network call", async () => {
  const h = harness({ api: downloadHandler([MD_META], MD_BYTES) });
  assert.equal(await runCli(["download", "--key", "OP-1396"], h.injected), 1);
  assert.equal(h.api.length, 0);
  assert.match(h.err.join("\n"), /--id/);
});

test("an opaque attachment is refused unnamed, and the refusal says how to proceed", async () => {
  const h = harness({ api: downloadHandler([BIN_META], Buffer.alloc(401)) });
  assert.equal(await runCli(["download", "--key", "OP-1396", "--id", "10223"], h.injected), 1);
  assert.equal(h.outBytes.length, 0);
  assert.match(h.err.join("\n"), /application\/octet-stream/);
  assert.match(h.err.join("\n"), /--accept application\/octet-stream/);
  assert.equal(h.api.length, 1);
});

// THE CASE THAT DECIDED THE PRINTABLE RULE: attach stores octet-stream when no
// --content-type is given, so our own uploads must stay readable.
test("an opaque attachment accepted by name is delivered when stdout is redirected", async () => {
  const meta = { ...BIN_META, filename: "notes.md", size: MD_BYTES.length };
  const h = harness({ api: downloadHandler([meta], MD_BYTES) });
  assert.equal(
    await runCli(["download", "--key", "OP-1396", "--id", "10223", "--accept", "application/octet-stream"], h.injected),
    0,
  );
  assert.equal(Buffer.concat(h.outBytes).toString("utf8"), MD_BYTES.toString("utf8"));
});

test("an accepted opaque attachment still never reaches a terminal", async () => {
  const h = harness(
    { api: downloadHandler([BIN_META], Buffer.alloc(401)) },
    { KHEREP_ATL_CRED_FILE_CLAUDE: CRED_PATH },
    { tty: true },
  );
  assert.equal(
    await runCli(["download", "--key", "OP-1396", "--id", "10223", "--accept", "application/octet-stream"], h.injected),
    1,
  );
  assert.equal(h.outBytes.length, 0);
  assert.match(h.err.join("\n"), /Terminal/);
});

// Golden rule 13: a 200 is not a measurement. A truncated download that nobody
// compared is indistinguishable from a short file.
test("a truncated download fails instead of printing a partial file", async () => {
  const h = harness({ api: downloadHandler([{ ...MD_META, size: MD_BYTES.length + 10 }], MD_BYTES) });
  assert.equal(await runCli(["download", "--key", "OP-1396", "--id", "10224"], h.injected), 1);
  assert.equal(h.outBytes.length, 0);
  assert.match(h.err.join("\n"), /unvollstaendig/);
});

// Rule 12: a body nobody could read must not look like a body that was empty.
test("a response without a byte stream is a named error, not an empty file", async () => {
  const h = harness({
    api: (_step: number, url?: string) => (String(url).includes("/attachment/content/")
      ? jsonResponse(200, {})
      : jsonResponse(200, { key: "OP-1396", fields: { attachment: [MD_META] } })),
  });
  assert.equal(await runCli(["download", "--key", "OP-1396", "--id", "10224"], h.injected), 1);
  assert.equal(h.outBytes.length, 0);
  assert.match(h.err.join("\n"), /Bytestrom/);
});

// OP-1396. get now says which files hang off the work item, and quietly says
// nothing when there are none.
test("get lists the attachments with the id download takes", async () => {
  const h = harness({
    api: () => jsonResponse(200, { key: "OP-7", fields: { summary: "S", attachment: [MD_META, BIN_META] } }),
  });
  assert.equal(await runCli(["get", "--key", "OP-7"], h.injected), 0);
  assert.ok(h.out.includes(`attachment: 10224 note.md text/markdown ${MD_BYTES.length}`));
  assert.ok(h.out.includes("attachment: 10223 notes.bin application/octet-stream 401"));
});

test("get stays silent about attachments when the work item has none", async () => {
  const h = harness({ api: () => jsonResponse(200, { key: "OP-7", fields: { summary: "S", attachment: [] } }) });
  assert.equal(await runCli(["get", "--key", "OP-7"], h.injected), 0);
  assert.equal(h.out.some((line) => line.startsWith("attachment")), false);
});
