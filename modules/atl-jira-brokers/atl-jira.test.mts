import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCredentialText,
  runCli,
  selectTransition,
  toAdf,
  type BrokerDeps,
  type CliResult,
  type FetchLike,
  type RequestOptions,
} from "./atl-jira.mts";

// Eine aufgezeichnete Anfrage. Der Broker schickt zu jedem Aufruf Optionen mit;
// der Ersatz unten macht das fuer den Typ sichtbar, ohne die Aufzeichnung zu
// veraendern - ein fehlender Body faellt am JSON.parse der Assertion auf.
interface RecordedCall {
  url: string;
  options: RequestOptions;
}

interface Counters {
  credentialReads: number;
  fetches: number;
  // OP-1396. Absent until a file read actually happens, so a test that expects
  // none can keep comparing the whole object.
  fileReads?: number;
}

const NO_REQUEST: RequestOptions = { method: "", headers: {} };

// result.output ist bewusst ein offener Record: jedes Kommando legt eigene
// Belegfelder hinein. Diese beiden Helfer lesen daraus, ohne den Typ zu
// faelschen - ein fehlendes Feld faellt in der Assertion auf.
const text = (value: unknown): string => (typeof value === "string" ? value : String(value));
const nested = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
);

const CLIENT_ID = "client-id-for-tests";
const CLIENT_SECRET = "secret-for-tests-1234";
const ACCESS_TOKEN = "access-token-must-not-be-reported";
const CLOUD_ID = "cloud-id-must-not-be-reported";
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

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// OP-1396. `files` is what readBytes may answer. Nothing is on disk: a test that
// reached the real filesystem would pass or fail for reasons that have nothing
// to do with the broker.
function dependencies(fetchImpl: FetchLike, files: Map<string, Buffer> = new Map()): Partial<BrokerDeps> {
  return {
    env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: "injected-test-path" },
    readFile: async () => `Client ID: ${CLIENT_ID}\nClient Secret: ${CLIENT_SECRET}\n`,
    readBytes: async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("not readable");
      return bytes;
    },
    fetch: fetchImpl,
  };
}

test("Codex credentials use only the scoped canonical binding including empty", async () => {
  let readPath = "";
  const readFile = async (value: string) => {
    readPath = value;
    return `Client ID: ${CLIENT_ID}\nClient Secret: ${CLIENT_SECRET}\n`;
  };
  const canonical = await runCli(["selftest"], {
    env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: "canonical", OTHER_VENDOR_ATL_CRED_FILE_CODEX: "other" },
    readFile, fetch: async () => jsonResponse(401, { error: "access_denied" }),
  });
  assert.equal(readPath, "canonical");
  assert.equal(canonical.exitCode, 1);

  readPath = "";
  const empty = await runCli(["selftest"], {
    env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: "", OTHER_VENDOR_ATL_CRED_FILE_CODEX: "other" },
    readFile, fetch: async () => jsonResponse(500),
  });
  assert.equal(readPath, "");
  assert.match(String(empty.output.error), /KHEREP_ATL_CRED_FILE_CODEX/);
});

test("unexpected transport and response failures never expose their error message", async () => {
  const sentinel = "REGRESSION_SENTINEL_PRIVATE";
  const result = await runCli(["get", "--key", "OP-1"], {
    ...dependencies(async () => ({
      status: 500,
      text: async () => { throw new Error(sentinel); },
    })),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.stringify(result.output).includes(sentinel), false);
  assert.equal(result.output.error, "Interner Fehler.");
});

test("wrong-project keys for commands and links fail before fetch", async () => {
  const commands = [
    ["update", "--key", "OTHER-1", "--summary", "x"],
    ["comment", "--key", "OTHER-1", "--body", "x"],
    ["get", "--key", "OTHER-1"],
    ["attach", "--key", "OTHER-1", "--file", "/nowhere/design.md"],
    ["transition", "--key", "OTHER-1", "--to", "in-progress"],
    ["link", "--type", "Duplicate", "--outward", "OTHER-1", "--inward", "OP-2"],
    ["unlink", "--type", "Duplicate", "--outward", "OP-1", "--inward", "OTHER-2"],
  ];
  for (const argv of commands) {
    const counters = { credentialReads: 0, fetches: 0 };
    const result = await runCli(argv, blockedDependencies(counters));
    assert.equal(result.exitCode, 1);
    assert.deepEqual(counters, { credentialReads: 0, fetches: 0 });
  }
});

test("create refuses a returned key from another project", async () => {
  const { calls, fetchImpl } = recorder((n) => n === 1
    ? jsonResponse(201, { key: "OTHER-1" })
    : jsonResponse(200));
  const result = await runCli(["create", "--type", "Task", "--summary", "x", "--body", "x"], dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(calls.some((call) => call.url.includes("/issue/OTHER-1")), false);
});

function blockedDependencies(counters: Counters): Partial<BrokerDeps> {
  return {
    env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: "must-not-be-read" },
    readFile: async () => {
      counters.credentialReads += 1;
      throw new Error("credential read must not run");
    },
    readBytes: async () => {
      counters.fileReads = (counters.fileReads ?? 0) + 1;
      throw new Error("file read must not run");
    },
    fetch: async () => {
      counters.fetches += 1;
      throw new Error("fetch must not run");
    },
  };
}

function assertNoPrivateOutput(result: CliResult): void {
  const rendered = JSON.stringify(result.output);
  for (const forbidden of [CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, CLOUD_ID, "account-id-private"]) {
    assert.equal(rendered.includes(forbidden), false, `private value leaked: ${forbidden}`);
  }
}

test("credential parser accepts both orderings and requires exactly one secret plus one client id", () => {
  for (const credentials of [
    `Client Secret: ${CLIENT_SECRET}\nClient ID: ${CLIENT_ID}\n`,
    `Client ID: ${CLIENT_ID}\nClient Secret: ${CLIENT_SECRET}\n`,
  ]) assert.deepEqual(parseCredentialText(credentials), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

  for (const invalid of [
    `Client ID: ${CLIENT_ID}\n`,
    `Client ID: ${CLIENT_ID}\nClient Secret: ${CLIENT_SECRET}\nExtra: value\n`,
    `Client Secret: first\nOther Secret: second\n`,
  ]) {
    assert.throws(() => parseCredentialText(invalid), (error: unknown) =>
      error instanceof Error
      && !error.message.includes(CLIENT_SECRET)
      && !error.message.includes(CLIENT_ID));
  }
});

test("ADF preserves UTF-8 text in the required v3 document shape", () => {
  assert.deepEqual(toAdf("Prüfung mit Ä, Ö, Ü und ß"), {
    type: "doc",
    version: 1,
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: "Prüfung mit Ä, Ö, Ü und ß" }],
    }],
  });
});

test("selftest discriminates the real and tampered secret, then verifies the app identity", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    calls.push({ url: String(url), options: options ?? NO_REQUEST });
    if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (calls.length === 2) return jsonResponse(401, { error: "access_denied", error_description: "denied" });
    if (calls.length === 3) return jsonResponse(200, { cloudId: CLOUD_ID });
    return jsonResponse(200, {
      accountId: "account-id-private",
      accountType: "app",
      displayName: "codexAI",
    });
  };

  const result = await runCli(["selftest"], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    token: { status: 200, tokenLength: ACCESS_TOKEN.length },
    control: { status: 401, error: "access_denied", errorDescription: "denied", tokenLength: 0 },
    tenantInfo: { status: 200 },
    myself: { status: 200, accountType: "app", displayName: "codexAI" },
    verdict: "PASS",
  });
  assert.equal(calls.length, 4);
  const realAuth = JSON.parse(Buffer.from(calls[0].options.body ?? []).toString("utf8"));
  const badAuth = JSON.parse(Buffer.from(calls[1].options.body ?? []).toString("utf8"));
  assert.equal(realAuth.client_secret, CLIENT_SECRET);
  assert.notEqual(badAuth.client_secret, CLIENT_SECRET);
  assert.equal(badAuth.client_secret.length, CLIENT_SECRET.length);
  assert.equal(calls[2].options.headers?.Authorization, undefined);
  assert.equal(calls[2].url, "https://jira.example.com/_edge/tenant_info");
  assert.match(calls[3].url, /\/rest\/api\/3\/myself$/);
  assert.equal(calls[3].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assertNoPrivateOutput(result);
});

test("selftest returns UNKNOWN when the control request does not discriminate", async () => {
  let call = 0;
  const result = await runCli(["selftest"], dependencies(async () => {
    call += 1;
    if (call <= 2) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    throw new Error("tenant lookup must not run after an inconclusive control");
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(result.output.verdict, "UNKNOWN");
  assert.equal(nested(result.output.token).status, 200);
  assert.equal(nested(result.output.control).status, 200);
  assertNoPrivateOutput(result);
});

test("create posts UTF-8 ADF and independently verifies creator identity", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    calls.push({ url: String(url), options: options ?? NO_REQUEST });
    if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (calls.length === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (calls.length === 3) return jsonResponse(201, { id: "private-id", key: "OP-999" });
    return jsonResponse(200, {
      key: "OP-999",
      fields: { creator: { accountType: "app", displayName: "codexAI" } },
    });
  };

  const result = await runCli([
    "create", "--type", "Task", "--summary", "UTF-8 Test", "--body", "Änderung prüfen",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    status: 201,
    issueKey: "OP-999",
    readbackStatus: 200,
    accountType: "app",
    displayName: "codexAI",
  });
  const createCall = calls[2];
  const payloadBytes = Buffer.from(createCall.options.body ?? []);
  const payload = JSON.parse(payloadBytes.toString("utf8"));
  assert.equal(createCall.options.headers["Content-Length"], String(payloadBytes.length));
  assert.deepEqual(payload.fields.description, toAdf("Änderung prüfen"));
  assert.deepEqual(payload.fields.project, { id: "20202" });
  assert.deepEqual(payload.fields.issuetype, { id: "31002" });
  assert.match(calls[3].url, /\/issue\/OP-999\?fields=creator$/);
  assertNoPrivateOutput(result);
});

test("missing Jira bindings fail before credentials and network access", async () => {
  let credentialReads = 0;
  let fetches = 0;
  const result = await runCli(["selftest"], {
    env: { KHEREP_ATL_CRED_FILE_CODEX: "unused" },
    readFile: async () => { credentialReads += 1; return ""; },
    fetch: async () => { fetches += 1; return jsonResponse(500); },
  });
  assert.equal(result.exitCode, 1);
  assert.match(String(result.output.error), /KHEREP_ATL_/);
  assert.deepEqual({ credentialReads, fetches }, { credentialReads: 0, fetches: 0 });
});

test("comment independently reads back the new comment and reports its app author without its id", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    calls.push({ url: String(url), options: options ?? NO_REQUEST });
    if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (calls.length === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (calls.length === 3) return jsonResponse(201, { id: "777" });
    return jsonResponse(200, {
      id: "777",
      author: { accountType: "app", displayName: "codexAI" },
    });
  };

  const result = await runCli([
    "comment", "--key", "OP-999", "--body", "Kommentar mit ß",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    status: 201,
    issueKey: "OP-999",
    readbackStatus: 200,
    accountType: "app",
    displayName: "codexAI",
  });
  assert.match(calls[3].url, /\/issue\/OP-999\/comment\/777$/);
  assert.equal(JSON.stringify(result.output).includes("777"), false);
  assertNoPrivateOutput(result);
});

test("Claude credential environment is ignored when the Codex variable is missing", async () => {
  let readAttempted = false;
  const result = await runCli(["selftest"], {
    env: { ...JIRA_ENV, OTHER_VENDOR_ATL_CRED_FILE: "must-not-be-used" },
    readFile: async () => { readAttempted = true; return ""; },
    fetch: async () => { throw new Error("network must not run"); },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, { status: 0, error: "KHEREP_ATL_CRED_FILE_CODEX ist nicht gesetzt." });
  assert.equal(readAttempted, false);
});

test("Sub-task requires a validated OP parent before authentication", async () => {
  let fetchAttempted = false;
  const result = await runCli([
    "create", "--type", "Sub-task", "--summary", "Child", "--body", "Body",
  ], {
    env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: "injected-test-path" },
    readFile: async () => `Client ID: ${CLIENT_ID}\nClient Secret: ${CLIENT_SECRET}\n`,
    fetch: async () => { fetchAttempted = true; throw new Error("must not run"); },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, { status: 0, error: "--parent fehlt." });
  assert.equal(fetchAttempted, false);
});

test("Sub-task create sends the required parent field", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    calls.push({ url: String(url), options: options ?? NO_REQUEST });
    if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (calls.length === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (calls.length === 3) return jsonResponse(201, { key: "OP-1001" });
    return jsonResponse(200, {
      key: "OP-1001",
      fields: { creator: { accountType: "app", displayName: "codexAI" }, parent: { key: "OP-999" } },
    });
  };

  const result = await runCli([
    "create", "--type", "Sub-task", "--parent", "OP-999",
    "--summary", "Child", "--body", "Body",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(Buffer.from(calls[2].options.body ?? []).toString("utf8"));
  assert.deepEqual(payload.fields.parent, { key: "OP-999" });
});

// OP-1124: die vier Fälle unterscheiden sich nur im Readback, deshalb steht der
// gemeinsame Vorlauf (Token, Tenant, 201, App-Creator) einmal hier. Jeder Test
// nennt nur die Felder, um die es ihm geht.
function subtaskCreate(readbackFields: Record<string, unknown>): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    calls.push({ url: String(url), options: options ?? NO_REQUEST });
    if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (calls.length === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (calls.length === 3) return jsonResponse(201, { key: "OP-1001" });
    return jsonResponse(200, {
      key: "OP-1001",
      fields: { creator: { accountType: "app", displayName: "codexAI" }, ...readbackFields },
    });
  };
  return { calls, fetchImpl };
}

// Gleichstand mit dem Claude-Broker: dort wird der Elternschlüssel getrimmt,
// bevor er grossgeschrieben und geprüft wird. Ohne das fällt " op-999 " hier
// am Regex, während derselbe Aufruf am anderen Broker durchgeht.
test("Sub-task create trims the padded parent before it validates and sends it", async () => {
  const { calls, fetchImpl } = subtaskCreate({ parent: { key: "OP-999" } });

  const result = await runCli([
    "create", "--type", "Sub-task", "--parent", " op-999 ",
    "--summary", "Child", "--body", "Body",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(Buffer.from(calls[2].options.body ?? []).toString("utf8"));
  assert.deepEqual(payload.fields.parent, { key: "OP-999" });
});

// Ein 201 belegt, dass der Vorgang existiert, nicht dass er am angeforderten
// Elternvorgang hängt (golden rule 13). Der Schlüssel wird deshalb mitgelesen
// und als gemessener Wert ausgegeben.
test("Sub-task create reads the parent back and reports the measured key", async () => {
  const { calls, fetchImpl } = subtaskCreate({ parent: { key: "OP-999" } });

  const result = await runCli([
    "create", "--type", "Sub-task", "--parent", "OP-999",
    "--summary", "Child", "--body", "Body",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    status: 201,
    issueKey: "OP-1001",
    readbackStatus: 200,
    accountType: "app",
    displayName: "codexAI",
    parent: "OP-999",
  });
  assert.match(calls[3].url, /\/issue\/OP-1001\?fields=creator,parent$/);
  assertNoPrivateOutput(result);
});

test("Sub-task create fails when the readback shows a different parent", async () => {
  const { fetchImpl } = subtaskCreate({ parent: { key: "OP-1" } });

  const result = await runCli([
    "create", "--type", "Sub-task", "--parent", "OP-999",
    "--summary", "Child", "--body", "Body",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 1);
  assert.equal(
    result.output.error,
    "Readback bestätigt den Elternvorgang nicht: erwartet OP-999, gelesen OP-1.",
  );
  assert.equal(result.output.parent, undefined);
});

test("Sub-task create with an assignee reads creator, parent and assignee back", async () => {
  const assigneeId = "5b10ac8d82e05b22cc7d4ef5";
  const { calls, fetchImpl } = subtaskCreate({
    parent: { key: "OP-999" },
    assignee: { accountId: assigneeId },
  });

  const result = await runCli([
    "create", "--type", "Sub-task", "--parent", "OP-999", "--assignee", assigneeId,
    "--summary", "Child", "--body", "Body",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.match(calls[3].url, /\/issue\/OP-1001\?fields=creator,parent,assignee$/);
  assert.deepEqual(result.output, {
    status: 201,
    issueKey: "OP-1001",
    readbackStatus: 200,
    accountType: "app",
    displayName: "codexAI",
    parent: "OP-999",
    assignee: assigneeId,
  });
  assertNoPrivateOutput(result);
});

test("unknown command flags are rejected before authentication", async () => {
  const cases = [
    ["create", "--summary", "X", "--body", "Y", "--typo", "Z"],
    ["comment", "--key", "OP-999", "--body", "Y", "--typo", "Z"],
    ["get", "--key", "OP-999", "--typo", "Z"],
  ];
  for (const argv of cases) {
    let fetchAttempted = false;
    const result = await runCli(argv, {
      env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: "injected-test-path" },
      readFile: async () => `Client ID: ${CLIENT_ID}\nClient Secret: ${CLIENT_SECRET}\n`,
      fetch: async () => { fetchAttempted = true; throw new Error("must not run"); },
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, { status: 0, error: "Unbekanntes CLI-Argument." });
    assert.equal(fetchAttempted, false);
  }
});

test("Done without acceptance fails before credentials and every request", async () => {
  const counters = { credentialReads: 0, fetches: 0 };
  const result = await runCli(
    ["transition", "--key", "OP-999", "--to", "done"],
    blockedDependencies(counters),
  );
  assert.equal(result.exitCode, 1);
  assert.match(text(result.output.error), /--acceptance fehlt/);
  assert.deepEqual(counters, { credentialReads: 0, fetches: 0 });
});

test("free-form transition selectors fail before credentials and every request", async () => {
  for (const target of ["31", "In Progress", "完成"]) {
    const counters = { credentialReads: 0, fetches: 0 };
    const result = await runCli(
      ["transition", "--key", "OP-999", "--to", target],
      blockedDependencies(counters),
    );
    assert.equal(result.exitCode, 1);
    assert.deepEqual(counters, { credentialReads: 0, fetches: 0 });
  }
});

test("transition resolves the available transition and verifies the resulting status", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    calls.push({ url: String(url), options: options ?? NO_REQUEST });
    if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (calls.length === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (calls.length === 3) return jsonResponse(200, {
      transitions: [
        { id: "21", name: "In Progress", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } },
        { id: "31", name: "Done", to: { id: "10002", name: "Done", statusCategory: { key: "done" } } },
      ],
    });
    if (calls.length === 4) return jsonResponse(204);
    return jsonResponse(200, { key: "OP-999", fields: { status: { id: "3", name: "In Progress" } } });
  };

  const result = await runCli([
    "transition", "--key", "OP-999", "--to", "indeterminate",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    status: 204,
    issueKey: "OP-999",
    readbackStatus: 200,
    statusId: "3",
    statusName: "In Progress",
  });
  assert.match(calls[2].url, /\/issue\/OP-999\/transitions$/);
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[3].options.body ?? []).toString("utf8")),
    { transition: { id: "21" } },
  );
  assert.match(calls[4].url, /\/issue\/OP-999\?fields=status$/);
  assertNoPrivateOutput(result);
});

test("transition reports safe available names when the target is unavailable", async () => {
  let call = 0;
  const result = await runCli([
    "transition", "--key", "OP-999", "--to", "indeterminate",
  ], dependencies(async () => {
    call += 1;
    if (call === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (call === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    return jsonResponse(200, {
      transitions: [
        { id: "11", name: "Open", to: { id: "10024", name: "Open", statusCategory: { key: "new" } } },
        { id: "31", name: "Done", to: { id: "10002", name: "Done", statusCategory: { key: "done" } } },
      ],
    });
  }));

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, {
    status: 200,
    issueKey: "OP-999",
    error: "Zielstatus ist nicht verfügbar.",
    availableStatusNames: ["Open", "Done"],
  });
  assertNoPrivateOutput(result);
});

// Der eigentliche Zweck der Kategorie-Aufloesung: der Anzeigename ist in einer
// Sprache, die der Aufrufer nicht kontrolliert, die Kategorie nicht.
const LOCALISED_TRANSITIONS = [
  { id: "11", name: "待办", to: { id: "10024", name: "待办", statusCategory: { key: "new" } } },
  { id: "21", name: "正在进行", to: { id: "3", name: "正在进行", statusCategory: { key: "indeterminate" } } },
  { id: "31", name: "完成", to: { id: "10002", name: "完成", statusCategory: { key: "done" } } },
];

test("selectTransition resolves a target by status category regardless of display language", () => {
  const { selected } = selectTransition(LOCALISED_TRANSITIONS, "indeterminate");
  assert.equal(selected?.id, "21");
});

test("selectTransition receives normalized status categories", () => {
  const { selected } = selectTransition(LOCALISED_TRANSITIONS, "done");
  assert.equal(selected?.id, "31");
});

test("selectTransition rejects transition ids and display names", () => {
  assert.deepEqual(selectTransition(LOCALISED_TRANSITIONS, "11"), {});
  assert.deepEqual(selectTransition(LOCALISED_TRANSITIONS, "完成"), {});
});

test("selectTransition reports an ambiguous category instead of guessing one", () => {
  const { selected, ambiguous } = selectTransition(
    [
      { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
      { id: "41", name: "Rejected", to: { name: "Rejected", statusCategory: { key: "done" } } },
    ],
    "done",
  );
  assert.equal(selected, undefined);
  assert.deepEqual(ambiguous?.map(({ id }) => id), ["31", "41"]);
});

test("selectTransition returns nothing when the target is not a category", () => {
  assert.deepEqual(selectTransition(LOCALISED_TRANSITIONS, "nonexistent"), {});
});

test("transition aborts with the candidates when a marked category is ambiguous", async () => {
  let call = 0;
  const result = await runCli(doneCommand(), dependencies(async () => {
    call += 1;
    if (call === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (call === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    return jsonResponse(200, {
      transitions: [
        { id: "31", name: "Done", to: { id: "10002", name: "Done", statusCategory: { key: "done" } } },
        { id: "41", name: "Rejected", to: { id: "10003", name: "Rejected", statusCategory: { key: "done" } } },
      ],
    });
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(call, 3, "kein Schreibvorgang bei Mehrdeutigkeit");
  assert.deepEqual(result.output.candidates, [
    { id: "31", statusName: "Done" },
    { id: "41", statusName: "Rejected" },
  ]);
  assertNoPrivateOutput(result);
});

test("transition resolves a category end to end and verifies the readback", async () => {
  let call = 0;
  let written: unknown = null;
  const result = await runCli(doneCommand(), dependencies(async (url, options) => {
    call += 1;
    if (call === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (call === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (call === 3) return jsonResponse(200, { transitions: LOCALISED_TRANSITIONS });
    if (call === 4) { written = JSON.parse(Buffer.from(options?.body ?? []).toString("utf8")); return jsonResponse(204); }
    return jsonResponse(200, { key: "OP-999", fields: { status: { id: "10002", name: "完成" } } });
  }));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(written, {
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
  assert.equal(result.output.statusId, "10002");
  assertNoPrivateOutput(result);
});

// OP-963: --labels und --components. Belegt wird der GESENDETE Body und die Zahl
// der Schreib-Requests, nicht nur der Exitcode: ein Broker, der das Feld gar
// nicht sendet, und einer, der es korrekt sendet, haben denselben Exitcode.
const COMPONENT_CATALOG = [
  { id: "10100", name: "Broker" },
  { id: "10101", name: "Hooks" },
];

const sentFields = (call: RecordedCall) => JSON.parse(Buffer.from(call.options.body ?? []).toString("utf8")).fields;
const writes = (recorded: RecordedCall[]) => recorded.filter((call) => call.options.method === "PUT");

function recorder(responses: (step: number) => Response): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options: options ?? NO_REQUEST });
      if (calls.length === 1) return jsonResponse(200, { access_token: ACCESS_TOKEN });
      if (calls.length === 2) return jsonResponse(200, { cloudId: CLOUD_ID });
      return responses(calls.length - 2);
    },
  };
}

test("an update without the new flags touches neither labels nor components", async () => {
  const { calls, fetchImpl } = recorder((n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "neu" } })
  ));
  const result = await runCli(["update", "--key", "OP-999", "--summary", "neu"], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, { status: 204, issueKey: "OP-999", readbackStatus: 200 });
  assert.deepEqual(Object.keys(sentFields(calls[2])), ["summary"]);
  assert.match(calls[3].url, /\/issue\/OP-999\?fields=summary$/);
  assertNoPrivateOutput(result);
});

test("an empty --labels clears the field and is sent as an empty array", async () => {
  const { calls, fetchImpl } = recorder((n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "alt", labels: [] } })
  ));
  const result = await runCli(["update", "--key", "OP-999", "--labels", ""], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sentFields(calls[2]), { labels: [] });
  assert.match(calls[3].url, /\?fields=summary,labels$/);
});

test("component names are resolved to ids and confirmed by the readback", async () => {
  const { calls, fetchImpl } = recorder((n) => {
    if (n === 1) return jsonResponse(200, COMPONENT_CATALOG);
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { summary: "alt", components: [{ id: "10101" }, { id: "10100" }] } });
  });
  const result = await runCli([
    "update", "--key", "OP-999", "--components", "Broker, Hooks",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 0);
  assert.match(calls[2].url, /\/project\/20202\/components$/);
  assert.deepEqual(sentFields(calls[3]), { components: [{ id: "10100" }, { id: "10101" }] });
  assert.match(calls[4].url, /\?fields=summary,components$/);
  assertNoPrivateOutput(result);
});

// Der eigentliche Grund fuer die Aufloesung vor dem Schreiben: sonst waeren
// Summary und Labels geschrieben, waehrend Jira den Aufruf wegen der Komponente
// abweist. Belegt an der Zahl der Schreib-Requests, nicht am Exitcode.
test("an unknown component name aborts before any write request goes out", async () => {
  const { calls, fetchImpl } = recorder((n) => (
    n === 1 ? jsonResponse(200, COMPONENT_CATALOG) : jsonResponse(204)
  ));
  const result = await runCli([
    "update", "--key", "OP-999", "--summary", "neu", "--components", "Nirgends",
  ], dependencies(fetchImpl));

  assert.equal(result.exitCode, 1);
  assert.equal(writes(calls).length, 0, "kein Schreib-Request");
  assert.equal(calls.length, 3, "Token, tenant_info und die Komponenten-Abfrage, sonst nichts");
  assert.match(text(result.output.error), /Unbekannte Komponente: Nirgends/);
  assertNoPrivateOutput(result);
});

test("an unreadable component catalog aborts before any write request goes out", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(403, { errorMessages: ["No permission"] }));
  const result = await runCli(["update", "--key", "OP-999", "--components", "Broker"], dependencies(fetchImpl));

  assert.equal(result.exitCode, 1);
  assert.equal(writes(calls).length, 0, "kein Schreib-Request");
  assert.deepEqual(result.output.errorMessages, ["No permission"]);
});

test("update fails when the readback does not show the written labels", async () => {
  const { fetchImpl } = recorder((n) => (
    n === 1 ? jsonResponse(204) : jsonResponse(200, { fields: { summary: "alt", labels: ["eins"] } })
  ));
  const result = await runCli(["update", "--key", "OP-999", "--labels", "eins,zwei"], dependencies(fetchImpl));

  assert.equal(result.exitCode, 1);
  assert.match(text(result.output.error), /erwartet \[eins, zwei\], gelesen \[eins\]/);
});

test("update fails when the readback does not show the written components", async () => {
  const { fetchImpl } = recorder((n) => {
    if (n === 1) return jsonResponse(200, COMPONENT_CATALOG);
    if (n === 2) return jsonResponse(204);
    return jsonResponse(200, { fields: { summary: "alt", components: [] } });
  });
  const result = await runCli(["update", "--key", "OP-999", "--components", "Broker"], dependencies(fetchImpl));

  assert.equal(result.exitCode, 1);
  assert.match(text(result.output.error), /Komponenten nicht: erwartet \[10100\], gelesen \[\]/);
});

test("an update without any field fails before authentication", async () => {
  const counters = { credentialReads: 0, fetches: 0 };
  const result = await runCli(["update", "--key", "OP-999"], blockedDependencies(counters));

  assert.equal(result.exitCode, 1);
  assert.match(text(result.output.error), /Nichts zu ändern/);
  assert.deepEqual(counters, { credentialReads: 0, fetches: 0 });
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
const sentJson = (call: RecordedCall) => JSON.parse(Buffer.from(call.options.body ?? []).toString("utf8"));
const linkWrites = (calls: RecordedCall[]) => calls.filter((call) => ["POST", "DELETE"].includes(call.options.method)
  && !String(call.url).includes("oauth/token"));

test("link resolves the type, sends both roles and confirms the link on the issue", async () => {
  const { calls, fetchImpl } = recorder((n) => {
    if (n === 1) return jsonResponse(200, LINK_TYPES);
    if (n === 2) return jsonResponse(201);
    return jsonResponse(200, LINKED);
  });
  const result = await runCli(linkCommand("link"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, { status: 201, link: "OP-1093 duplicates OP-827", readbackStatus: 200, linkId: "10501" });
  assert.match(calls[2].url, /\/issueLinkType$/);
  assert.match(calls[3].url, /\/issueLink$/);
  assert.deepEqual(sentJson(calls[3]), {
    type: { id: "1000" },
    outwardIssue: { key: "OP-1093" },
    inwardIssue: { key: "OP-827" },
  });
  assert.match(calls[4].url, /\/issue\/OP-1093\?fields=issuelinks$/);
  assertNoPrivateOutput(result);
});

test("an unknown link type aborts before any write request goes out", async () => {
  const { calls, fetchImpl } = recorder((n) => (n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(201)));
  const result = await runCli(["link", "--type", "Duplicates", "--outward", "OP-1093", "--inward", "OP-827"], dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(linkWrites(calls).length, 0);
  assert.equal(calls.length, 3);
  assert.match(text(result.output.error), /Unbekannter Verknüpfungstyp: Duplicates/);
  assert.match(text(result.output.error), /Duplicate, Blocks/);
  assertNoPrivateOutput(result);
});

test("an unreadable link type catalog aborts before any write request goes out", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(403, { errorMessages: ["No permission"] }));
  const result = await runCli(linkCommand("link"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(linkWrites(calls).length, 0);
  assert.deepEqual(result.output.errorMessages, ["No permission"]);
});

test("link and unlink without their mandatory flags fail before authentication", async () => {
  for (const argv of [
    ["link", "--outward", "OP-1093", "--inward", "OP-827"],
    ["link", "--type", "Duplicate", "--inward", "OP-827"],
    ["link", "--type", "Duplicate", "--outward", "OP-1093"],
    ["unlink", "--type", "Duplicate", "--outward", "OP-1093"],
    ["unlink", "--type", "Duplicate", "--outward", "OP-1093", "--inward", "kein-key"],
  ]) {
    const counters = { credentialReads: 0, fetches: 0 };
    const result = await runCli(argv, blockedDependencies(counters));
    assert.equal(result.exitCode, 1);
    assert.deepEqual(counters, { credentialReads: 0, fetches: 0 });
    assert.match(text(result.output.error), /fehlt\.|kein Vorgangsschlüssel/);
  }
});

test("an unknown flag on link is refused like everywhere else", async () => {
  const counters = { credentialReads: 0, fetches: 0 };
  const result = await runCli([
    "link", "--type", "Duplicate", "--outward", "OP-1093", "--inward", "OP-827", "--key", "OP-1",
  ], blockedDependencies(counters));
  assert.equal(result.exitCode, 1);
  assert.equal(counters.fetches, 0);
  assert.equal(result.output.error, "Unbekanntes CLI-Argument.");
});

test("link fails when the readback shows the pair linked the other way round", async () => {
  const { fetchImpl } = recorder((n) => {
    if (n === 1) return jsonResponse(200, LINK_TYPES);
    if (n === 2) return jsonResponse(201);
    return jsonResponse(200, { fields: { issuelinks: [{ id: "10502", type: { id: "1000" }, outwardIssue: { key: "OP-827" } }] } });
  });
  const result = await runCli(linkCommand("link"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.linkId, undefined);
  assert.match(text(result.output.error), /Readback bestätigt die Verknüpfung nicht/);
});

test("link fails when the readback itself does not load", async () => {
  const { fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 2 ? jsonResponse(201) : jsonResponse(500, { errorMessages: ["boom"] }));
  const result = await runCli(linkCommand("link"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.readbackStatus, 500);
  assert.equal(result.output.error, "Readback nach dem Verknüpfen fehlgeschlagen.");
});

test("link reports a refused write and does not claim a readback", async () => {
  const { calls, fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(404, { errorMessages: ["issue linking is disabled"] }));
  const result = await runCli(linkCommand("link"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 4);
  assert.deepEqual(result.output.errorMessages, ["issue linking is disabled"]);
  assert.equal(result.output.link, "OP-1093 duplicates OP-827");
});

test("unlink reads the link id off the issue and confirms the removal", async () => {
  const { calls, fetchImpl } = recorder((n) => {
    if (n === 1) return jsonResponse(200, LINK_TYPES);
    if (n === 2) return jsonResponse(200, LINKED);
    if (n === 3) return jsonResponse(204);
    return jsonResponse(200, UNLINKED);
  });
  const result = await runCli(linkCommand("unlink"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, { status: 204, link: "OP-1093 duplicates OP-827", linkId: "10501", readbackStatus: 200 });
  assert.equal(calls[4].options.method, "DELETE");
  assert.match(calls[4].url, /\/issueLink\/10501$/);
  assertNoPrivateOutput(result);
});

test("unlink accepts the documented 200 as well as the 204", async () => {
  const { fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 2 ? jsonResponse(200, LINKED) : n === 3 ? jsonResponse(200) : jsonResponse(200, UNLINKED));
  const result = await runCli(linkCommand("unlink"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, 200);
});

test("unlink deletes nothing when the issue carries no such link", async () => {
  const { calls, fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(200, UNLINKED));
  const result = await runCli(linkCommand("unlink"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(linkWrites(calls).length, 0);
  assert.match(text(result.output.error), /Keine passende Verknüpfung: OP-1093 duplicates OP-827/);
});

test("unlink refuses to pick when several links match", async () => {
  const { calls, fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : jsonResponse(200, {
    fields: { issuelinks: [LINKED.fields.issuelinks[0], { ...LINKED.fields.issuelinks[0], id: "10502" }] },
  }));
  const result = await runCli(linkCommand("unlink"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(linkWrites(calls).length, 0);
  assert.match(text(result.output.error), /Mehrere passende Verknüpfungen: 10501, 10502/);
});

test("unlink fails when the readback still shows the link", async () => {
  const { fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 3 ? jsonResponse(204) : jsonResponse(200, LINKED));
  const result = await runCli(linkCommand("unlink"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.linkId, "10501");
  assert.match(text(result.output.error), /Readback zeigt die Verknüpfung weiterhin/);
});

test("unlink fails when the readback after the delete does not load", async () => {
  const { fetchImpl } = recorder((n) => n === 1 ? jsonResponse(200, LINK_TYPES) : n === 2 ? jsonResponse(200, LINKED) : n === 3 ? jsonResponse(204) : jsonResponse(500, { errorMessages: ["boom"] }));
  const result = await runCli(linkCommand("unlink"), dependencies(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.readbackStatus, 500);
  assert.equal(result.output.error, "Readback nach dem Lösen fehlgeschlagen.");
});

// OP-1372. Same coverage as the Claude broker: the pure module is tested
// separately, this pins that the verb is wired and returns the page shape.
test("search asks the supported route and returns the page it received", async () => {
  const urls: string[] = [];
  // Routed by URL, not by call number: how many token and tenant_info requests a
  // command makes is exactly what the session cache changes.
  const result = await runCli(["search", "--jql", "project = OP", "--max", "5"], {
    ...dependencies(async (url) => {
      urls.push(url);
      if (url.includes("oauth/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
      if (url.includes("_edge/tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
      return jsonResponse(200, {
        isLast: true,
        issues: [{ key: "OP-42", fields: { summary: "Ein Titel", status: { name: "To Do" } } }],
      });
    }),
  });
  assert.equal(result.exitCode, 0);
  const search = urls.find((url) => url.includes("/search"));
  assert.ok(search?.includes("/rest/api/3/search/jql?"), String(search));
  const query = new URLSearchParams(String(search).split("?")[1]);
  assert.equal(query.get("jql"), "project = OP");
  assert.equal(query.get("maxResults"), "5");
  assert.equal(result.output.count, 1);
  assert.equal(result.output.last, true);
  assert.equal(result.output.nextPageToken, null);
  assert.deepEqual(result.output.issues, [
    { key: "OP-42", status: "To Do", summary: "Ein Titel", updated: "" },
  ]);
});

test("a blank --jql is refused before any network call", async () => {
  const urls: string[] = [];
  const result = await runCli(["search", "--jql", "   "], {
    ...dependencies(async (url) => { urls.push(url); return jsonResponse(200, {}); }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "--jql fehlt.");
  assert.equal(urls.length, 0);
});

// OP-1396. Attach. Nothing here touches the network or the disk: the fake fetch
// records what the broker would have sent, which is the only thing a test can
// prove without the live acceptance the Director runs separately.
const ATTACH_FILE = "/nowhere/2026-09-18-design.md";
const ATTACH_BYTES = Buffer.from("# Design\n\nerste Zeile\n", "utf8");
const UPLOADED = [{ id: "10222", filename: "2026-09-18-design.md" }];

function attachFiles(): Map<string, Buffer> {
  return new Map([[ATTACH_FILE, ATTACH_BYTES]]);
}

function attachRecorder(
  upload: Response = jsonResponse(200, UPLOADED),
  readback: Response = jsonResponse(200, { key: "OP-999", fields: { attachment: UPLOADED } }),
) {
  return recorder((step) => (step === 1 ? upload : readback));
}

test("attach posts multipart with the XSRF header and never application/json", async () => {
  const { calls, fetchImpl } = attachRecorder();
  const result = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE],
    dependencies(fetchImpl, attachFiles()),
  );

  assert.equal(result.exitCode, 0);
  const sent = calls[2];
  assert.match(sent.url, /\/rest\/api\/3\/issue\/OP-999\/attachments$/);
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.options.headers["X-Atlassian-Token"], "no-check");
  assert.match(sent.options.headers["Content-Type"], /^multipart\/form-data; boundary=----KherepFormBoundary/);
  assert.equal(sent.options.headers["Content-Type"].includes("application/json"), false);

  const body = Buffer.from(sent.options.body ?? []).toString("utf8");
  assert.match(body, /Content-Disposition: form-data; name="file"; filename="2026-09-18-design\.md"/);
  assert.match(body, /Content-Type: application\/octet-stream/);
  assert.ok(body.includes("# Design"));

  assert.deepEqual(result.output, {
    status: 200,
    issueKey: "OP-999",
    attachments: [{ id: "10222", filename: "2026-09-18-design.md" }],
    readbackStatus: 200,
  });
  assertNoPrivateOutput(result);
});

test("attach uses the same token and cloudId as every other verb", async () => {
  const { calls, fetchImpl } = attachRecorder();
  const result = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE],
    dependencies(fetchImpl, attachFiles()),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(calls.filter((call) => call.url.includes("oauth/token")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("_edge/tenant_info")).length, 1);
  // The upload and the readback are one session, so they carry one Authorization.
  assert.equal(calls[2].options.headers.Authorization, calls[3].options.headers.Authorization);
  assert.equal(calls[2].options.headers["Accept-Language"], "en-US");
});

test("attach reads the work item back instead of believing the upload answer", async () => {
  const { calls, fetchImpl } = attachRecorder(
    jsonResponse(200, UPLOADED),
    jsonResponse(200, { key: "OP-999", fields: { attachment: [{ id: "99", filename: "other.md" }] } }),
  );
  const result = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE],
    dependencies(fetchImpl, attachFiles()),
  );
  assert.equal(result.exitCode, 1);
  assert.match(calls[3].url, /\/issue\/OP-999\?fields=attachment$/);
  assert.match(String(result.output.error), /Readback bestaetigt den Anhang nicht/);
});

test("attach treats an answer that proves no attachment as a failure", async () => {
  for (const answer of [jsonResponse(200, []), jsonResponse(200, { id: "1" }), jsonResponse(201, UPLOADED)]) {
    const { calls, fetchImpl } = attachRecorder(answer);
    const result = await runCli(
      ["attach", "--key", "OP-999", "--file", ATTACH_FILE],
      dependencies(fetchImpl, attachFiles()),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(calls.length, 3, "a failed upload must not be read back as if it had worked");
  }
});

test("attach reports a 4xx from the endpoint without inventing a success", async () => {
  const { fetchImpl } = attachRecorder(jsonResponse(413, { errorMessages: ["The file is too large."] }));
  const result = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE],
    dependencies(fetchImpl, attachFiles()),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.status, 413);
  assert.deepEqual(result.output.errorMessages, ["The file is too large."]);
});

test("attach names the part content type explicitly and lets the caller override it", async () => {
  const chosen = attachRecorder();
  const good = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE, "--content-type", "text/markdown"],
    dependencies(chosen.fetchImpl, attachFiles()),
  );
  assert.equal(good.exitCode, 0);
  assert.match(Buffer.from(chosen.calls[2].options.body ?? []).toString("utf8"), /Content-Type: text\/markdown/);

  const refused = attachRecorder();
  const bad = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE, "--content-type", "text/plain; charset=utf8"],
    dependencies(refused.fetchImpl, attachFiles()),
  );
  assert.equal(bad.exitCode, 1);
  assert.equal(refused.calls.length, 0, "an invalid media type must fail before any network call");
});

test("attach fails closed on a missing or unreadable file and never names the path", async () => {
  const missing = attachRecorder();
  const result = await runCli(
    ["attach", "--key", "OP-999", "--file", "/nowhere/absent.md"],
    dependencies(missing.fetchImpl, attachFiles()),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "--file ist nicht lesbar.");
  assert.equal(JSON.stringify(result.output).includes("/nowhere/absent.md"), false);
  assert.equal(missing.calls.length, 0);

  const blank = attachRecorder();
  const empty = await runCli(
    ["attach", "--key", "OP-999", "--file", "   "],
    dependencies(blank.fetchImpl, attachFiles()),
  );
  assert.equal(empty.exitCode, 1);
  assert.equal(empty.output.error, "--file fehlt.");
  assert.equal(blank.calls.length, 0);
});

test("attach rejects a flag it does not know and a repeated one", async () => {
  const unknown = attachRecorder();
  const strange = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE, "--size", "9"],
    dependencies(unknown.fetchImpl, attachFiles()),
  );
  assert.equal(strange.exitCode, 1);
  assert.equal(strange.output.error, "Unbekanntes CLI-Argument.");

  // One file per call, and this is where that is enforced: a second --file is a
  // repeated flag, not a second attachment.
  const twice = attachRecorder();
  const repeated = await runCli(
    ["attach", "--key", "OP-999", "--file", ATTACH_FILE, "--file", ATTACH_FILE],
    dependencies(twice.fetchImpl, attachFiles()),
  );
  assert.equal(repeated.exitCode, 1);
  assert.equal(repeated.output.error, "Ein CLI-Argument wurde mehrfach angegeben.");
  assert.equal(twice.calls.length, 0);
});

// OP-1387. Der Vorgang wurde gelesen, die Beschreibung aber weder angefordert
// noch ausgegeben: ein Aufrufer konnte nicht erfahren, was der Vorgang sagt.
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

test("get asks for the description and reports it as readable text", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, {
    key: "OP-999",
    fields: { summary: "Ein Titel", description: DESCRIPTION_DOC },
  }));
  const result = await runCli(["get", "--key", "OP-999"], dependencies(fetchImpl));
  assert.equal(result.exitCode, 0);
  assert.match(calls[2].url, /\?fields=summary,status,description,creator,attachment$/);
  assert.equal(result.output.description, "## Ziel\n\n- eins\n- zwei");
});

test("get stays silent about a work item that has no description", async () => {
  for (const fields of [{ summary: "T" }, { summary: "T", description: null }]) {
    const { fetchImpl } = recorder(() => jsonResponse(200, { key: "OP-999", fields }));
    const result = await runCli(["get", "--key", "OP-999"], dependencies(fetchImpl));
    assert.equal(result.exitCode, 0);
    assert.equal("description" in result.output, false);
  }
});

test("a description that renders to nothing is reported, not dropped", async () => {
  const { fetchImpl } = recorder(() => jsonResponse(200, {
    key: "OP-999",
    fields: { description: { type: "doc", version: 1, content: [] } },
  }));
  const result = await runCli(["get", "--key", "OP-999"], dependencies(fetchImpl));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.description, "<vorhanden, aber nicht als Text darstellbar>");
});

// OP-1396. The readback. Same contract as the Claude broker, proven separately:
// parity is a condition of the work, and a shared module does not prove that
// both callers actually reach it.
const DL_BYTES = Buffer.from("# Handover\n\nZeile mit Ae, Oe, Ue und ss.\n", "utf8");
const DL_META = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: DL_BYTES.length };
const DL_BIN = { id: "10223", filename: "notes.bin", mimeType: "application/octet-stream", size: 401 };

// A real Response carries arrayBuffer(), which is exactly what the download
// path needs and what a JSON-only stub must not accidentally provide.
function bytesResponse(status: number, bytes: Buffer): Response {
  return new Response(bytes, { status, headers: { "Content-Type": "text/plain" } });
}

// A download starts at the work item's own attachment list, which is what makes
// --key bind: the metadata endpoint carries no issue reference at all.
function downloadFetch(entries: unknown[], bytes: Buffer, calls: string[] = [], issueKey = "OP-999"): FetchLike {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (String(url).includes("tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (String(url).includes("/attachment/content/")) return bytesResponse(200, bytes);
    return jsonResponse(200, { key: issueKey, fields: { attachment: entries } });
  };
}

test("download hands the attachment bytes back for stdout, and nothing else", async () => {
  const result = await runCli(["download", "--key", "OP-999", "--id", "10224"], {
    ...dependencies(downloadFetch([DL_META], DL_BYTES)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutBytes?.toString("utf8"), DL_BYTES.toString("utf8"));
  // The envelope describes the file; it never becomes the file.
  assert.deepEqual(result.output, {
    status: 200,
    attachmentId: "10224",
    filename: "note.md",
    mimeType: "text/markdown",
    bytes: DL_BYTES.length,
  });
});

test("download reads the work item's list, then the content with redirect=false", async () => {
  const calls: string[] = [];
  await runCli(["download", "--key", "OP-999", "--id", "10224"], {
    ...dependencies(downloadFetch([DL_META], DL_BYTES, calls)),
    stdoutIsTty: () => false,
  });
  const api = calls.filter((url) => url.includes("/rest/api/3/"));
  // Two requests, the same count as before the key was validated: the list read
  // REPLACED the metadata read rather than being added to it.
  assert.equal(api.length, 2);
  assert.match(api[0], /\/rest\/api\/3\/issue\/OP-999\?fields=attachment$/);
  assert.match(api[1], /\/rest\/api\/3\/attachment\/content\/10224\?redirect=false$/);
});

// One auth path per broker: the download must not mint a second token.
test("download reuses the one token and cloudId of the run", async () => {
  const calls: string[] = [];
  await runCli(["download", "--key", "OP-999", "--id", "10224"], {
    ...dependencies(downloadFetch([DL_META], DL_BYTES, calls)),
    stdoutIsTty: () => false,
  });
  assert.equal(calls.filter((url) => url.includes("oauth/token")).length, 1);
  assert.equal(calls.filter((url) => url.includes("tenant_info")).length, 1);
});

// THE REPORTED DEFECT, on the broker that did not have it: the Codex side only
// escaped it because its option allowlist rejected --key, which is protection by
// accident. Now the key binds here for the same reason it binds in attach.
test("an attachment of another work item is refused, naming both values", async () => {
  const calls: string[] = [];
  const result = await runCli(["download", "--key", "OP-999", "--id", "10222"], {
    ...dependencies(downloadFetch([DL_META], DL_BYTES, calls)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutBytes, undefined);
  assert.match(String(result.output.error), /10222/);
  assert.match(String(result.output.error), /OP-999/);
  // Refused BEFORE the content request: the foreign file is never fetched.
  assert.equal(calls.filter((url) => url.includes("/attachment/content/")).length, 0);
});

test("a key naming a work item that does not exist fails as a 404, not as a foreign file", async () => {
  const missing: FetchLike = async (url) => {
    if (String(url).includes("oauth/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (String(url).includes("tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
    return jsonResponse(404, { errorMessages: ["Issue does not exist"] });
  };
  const result = await runCli(["download", "--key", "OP-999999", "--id", "10222"], {
    ...dependencies(missing),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutBytes, undefined);
  assert.equal(result.output.status, 404);
});

test("download without a key is refused before any network call", async () => {
  const calls: string[] = [];
  const result = await runCli(["download", "--id", "10224"], {
    ...dependencies(downloadFetch([DL_META], DL_BYTES, calls)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 0);
  assert.match(String(result.output.error), /--key/);
});

test("download without an id is refused before any network call", async () => {
  const calls: string[] = [];
  const result = await runCli(["download", "--key", "OP-999"], {
    ...dependencies(downloadFetch([DL_META], DL_BYTES, calls)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 0);
  assert.match(String(result.output.error), /--id/);
});

test("an opaque attachment is refused unnamed, and the refusal says how to proceed", async () => {
  const calls: string[] = [];
  const result = await runCli(["download", "--key", "OP-999", "--id", "10223"], {
    ...dependencies(downloadFetch([DL_BIN], Buffer.alloc(401), calls)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutBytes, undefined);
  assert.match(String(result.output.error), /--accept application\/octet-stream/);
  assert.equal(calls.filter((url) => url.includes("/attachment/content/")).length, 0);
});

// THE CASE THAT DECIDED THE PRINTABLE RULE: attach stores octet-stream when no
// --content-type is given, so our own uploads must stay readable.
test("an opaque attachment accepted by name is delivered when stdout is redirected", async () => {
  const meta = { ...DL_BIN, filename: "notes.md", size: DL_BYTES.length };
  const result = await runCli(["download", "--key", "OP-999", "--id", "10223", "--accept", "application/octet-stream"], {
    ...dependencies(downloadFetch([meta], DL_BYTES)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutBytes?.toString("utf8"), DL_BYTES.toString("utf8"));
});

test("an accepted opaque attachment still never reaches a terminal", async () => {
  const result = await runCli(["download", "--key", "OP-999", "--id", "10223", "--accept", "application/octet-stream"], {
    ...dependencies(downloadFetch([DL_BIN], Buffer.alloc(401))),
    stdoutIsTty: () => true,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutBytes, undefined);
  assert.match(String(result.output.error), /Terminal/);
});

// Golden rule 13: a 200 is not a measurement.
test("a truncated download fails instead of handing back a partial file", async () => {
  const result = await runCli(["download", "--key", "OP-999", "--id", "10224"], {
    ...dependencies(downloadFetch([{ ...DL_META, size: DL_BYTES.length + 10 }], DL_BYTES)),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutBytes, undefined);
  assert.match(String(result.output.error), /unvollstaendig/);
});

// Rule 12: a body nobody could read must not look like a body that was empty.
test("a response without a byte stream is a named error, not an empty file", async () => {
  const noBytes: FetchLike = async (url) => {
    if (String(url).includes("oauth/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (String(url).includes("tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
    if (String(url).includes("/attachment/content/")) return { status: 200, async text() { return ""; } };
    return jsonResponse(200, { key: "OP-999", fields: { attachment: [DL_META] } });
  };
  const result = await runCli(["download", "--key", "OP-999", "--id", "10224"], {
    ...dependencies(noBytes),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutBytes, undefined);
  assert.match(String(result.output.error), /Bytestrom/);
});

// OP-1396. get now says which files hang off the work item, and quietly says
// nothing when there are none.
test("get lists the attachments with the id download takes", async () => {
  const listing: FetchLike = async (url) => {
    if (String(url).includes("oauth/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (String(url).includes("tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
    return jsonResponse(200, { key: "OP-999", fields: { summary: "S", attachment: [DL_META] } });
  };
  const result = await runCli(["get", "--key", "OP-999"], {
    ...dependencies(listing),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.attachments, [DL_META]);
});

test("get stays silent about attachments when the work item has none", async () => {
  const empty: FetchLike = async (url) => {
    if (String(url).includes("oauth/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN });
    if (String(url).includes("tenant_info")) return jsonResponse(200, { cloudId: CLOUD_ID });
    return jsonResponse(200, { key: "OP-999", fields: { summary: "S", attachment: [] } });
  };
  const result = await runCli(["get", "--key", "OP-999"], {
    ...dependencies(empty),
    stdoutIsTty: () => false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal("attachments" in result.output, false);
});
