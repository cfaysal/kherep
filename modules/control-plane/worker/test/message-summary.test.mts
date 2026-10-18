import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import rootPackage from "../../../../package.json" with { type: "json" };
import worker from "../src/index.mts";
import { BASE, registry, workerFetch } from "./helpers.mts";

// Issue #493, step 1: GET /api/messages/summary, a read-only diagnostic of one
// sender's message rows. Counts only; no node id, message id or text.
const TEAM = "https://team.example.com";
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const NOW = 1_000 * DAY;
let signingKey: JoseKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "summary-kid", alg: "RS256", use: "sig" };
  // Stand-in for <team domain>/cdn-cgi/access/certs; nothing leaves the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    return new Response("unexpected fetch", { status: 599 });
  });
});

afterAll(() => vi.restoreAllMocks());

const token = (claims: { iss?: string; aud?: string; key?: JoseKey } = {}) => new SignJWT({ email: "operator@example.com" })
  .setProtectedHeader({ alg: "RS256", kid: "summary-kid" }).setIssuer(claims.iss ?? TEAM).setAudience(claims.aud ?? "test-audience")
  .setIssuedAt().setExpirationTime("5m").sign(claims.key ?? signingKey);

async function api(path: string, jwt?: string): Promise<Response> {
  return workerFetch(path, jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : {});
}

interface Seed { state: string; deletable: number | null; created: number; deleteAfter?: number }

// Rows straight into SQLite, each with a synthetic secret text, session and reason.
async function seed(from: string, rows: Seed[]): Promise<string[]> {
  const ids = rows.map(() => crypto.randomUUID());
  await runInDurableObject(registry(), (_i, state) => {
    rows.forEach((r, i) => state.storage.sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, text, state,
      reason, created_at, updated_at, expires_at, deletable, delete_after) VALUES (?, ?, 'secret-session', ?, 'secret-target', 'secret-text',
      ?, 'secret-reason', ?, ?, ?, ?, ?)`, ids[i], from, crypto.randomUUID(), r.state, r.created, r.created, r.created + DAY,
    r.deletable, r.deleteAfter ?? null));
  });
  return ids;
}

const group = (state: string, deletable: string, values: Partial<Record<string, number>>) => ({
  state, deletable, count: 1, withDeadline: 0, ageUnder24h: 0, age1to7d: 0, ageOver7d: 0, ...values,
});

describe("GET /api/messages/summary", () => {
  it("groups one sender's rows by state and deletable mark with clock-relative age buckets", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await seed(a, [
      { state: "delivered", deletable: 1, created: NOW - HOUR },
      { state: "delivered", deletable: 1, created: NOW - 2 * DAY, deleteAfter: NOW + DAY },
      { state: "delivered", deletable: null, created: NOW - 10 * DAY },
      { state: "delivered", deletable: null, created: NOW - 7 * DAY },
      // Two different non-1 marks are one "other" group, not two.
      { state: "delivered", deletable: 0, created: NOW - 3 * DAY },
      { state: "delivered", deletable: 2, created: NOW - 8 * DAY },
      { state: "accepted", deletable: null, created: NOW - DAY },
      { state: "bogus", deletable: 1, created: NOW - HOUR },
    ]);
    await seed(b, [{ state: "replied", deletable: 1, created: NOW - HOUR }, { state: "replied", deletable: 1, created: NOW - 9 * DAY }]);

    const summary = await registry().messageSummary(a, NOW);
    expect(summary.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(summary.rowsRead).toBeGreaterThan(0);
    // Boundaries: exactly 24 h old is under 24 h, exactly 7 d old is 1 to 7 d.
    expect(summary.groups).toEqual([
      group("accepted", "null", { ageUnder24h: 1 }),
      group("delivered", "1", { count: 2, withDeadline: 1, ageUnder24h: 1, age1to7d: 1 }),
      group("delivered", "null", { count: 2, age1to7d: 1, ageOver7d: 1 }),
      group("delivered", "other", { count: 2, age1to7d: 1, ageOver7d: 1 }),
      group("other", "1", { ageUnder24h: 1 }),
    ]);

    // The second sender's rows stay out of the first's summary and vice versa.
    const other = await registry().messageSummary(b, NOW);
    expect(other.groups).toEqual([group("replied", "1", { count: 2, ageUnder24h: 1, ageOver7d: 1 })]);
    expect((await registry().messageSummary(crypto.randomUUID(), NOW)).groups).toEqual([]);
  });

  // Only the requested sender's rows are read, all of them: no cap, linear in that sender's history.
  it("reads the requested sender's whole history through its index, whatever other senders hold", async () => {
    const a = crypto.randomUUID();
    const many = 300;
    await seed(a, Array.from({ length: many }, (_, i) => ({ state: "delivered", deletable: null, created: NOW - i * HOUR })));
    const read = async () => {
      const summary = await registry().messageSummary(a, NOW);
      expect(summary.groups.reduce((sum, g) => sum + g.count, 0)).toBe(many);
      return summary.rowsRead;
    };
    const before = await read();
    expect(before).toBeGreaterThanOrEqual(many);
    expect(before).toBeLessThanOrEqual(2 * many + 2);
    for (let sender = 0; sender < 4; sender++) {
      await seed(crypto.randomUUID(), Array.from({ length: 500 }, () => ({ state: "delivered", deletable: 1, created: NOW })));
    }
    // At most the one index entry past the sender's range, which another sender may now fill.
    const after = await read();
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThanOrEqual(before + 1);
  });

  it("returns exactly one group per state bucket and deletable bucket", async () => {
    const a = crypto.randomUUID();
    const marks = [1, null, 0, 2, -1, 7];
    await seed(a, ["delivered", "replied", "unknown-x", "unknown-y"].flatMap((state) => marks.map((deletable) => ({
      state, deletable, created: NOW - DAY,
    }))));
    const { groups } = await registry().messageSummary(a, NOW);
    const keys = groups.map((g) => `${g.state}/${g.deletable}`);
    expect(keys).toEqual(["delivered/1", "delivered/null", "delivered/other", "other/1", "other/null", "other/other",
      "replied/1", "replied/null", "replied/other"]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 4, 2, 2, 8, 1, 1, 4]);
  });

  it("is logged by the SQL meter under its own path with the rows it reports", async () => {
    const a = crypto.randomUUID();
    await seed(a, [{ state: "delivered", deletable: null, created: NOW - DAY }]);
    const log = vi.spyOn(console, "log");
    try {
      const summary = await runInDurableObject(registry(), (instance) => instance.messageSummary(a, NOW));
      const lines = log.mock.calls.map(([line]) => line as { event?: string; path?: string; rowsRead?: number; rowsWritten?: number })
        .filter((line) => line?.event === "registry.sql" && line.path === "messageSummary");
      expect(lines).toEqual([{ event: "registry.sql", path: "messageSummary", rowsRead: summary.rowsRead, rowsWritten: 0 }]);
    } finally {
      log.mockRestore();
    }
  });

  it("is refused without a valid Access JWT and without a valid sender", async () => {
    const a = crypto.randomUUID();
    await seed(a, [{ state: "delivered", deletable: 1, created: NOW }]);
    const path = `/api/messages/summary?from=${a}`;
    const otherKey = (await generateKeyPair("RS256")).privateKey;
    expect((await api(path)).status).toBe(403);
    expect((await api(path, "not.a.jwt")).status).toBe(403);
    expect((await api(path, await token({ aud: "other-audience" }))).status).toBe(403);
    expect((await api(path, await token({ iss: "https://other.example.com" }))).status).toBe(403);
    expect((await api(path, await token({ key: otherKey }))).status).toBe(403);
    // The JWT header only: no other header is read as the Access token.
    expect((await workerFetch(path, { headers: { "cf-access-token": await token() } })).status).toBe(403);
    const signed = new Request(`${BASE}${path}`, { headers: { "cf-access-jwt-assertion": await token() } });
    expect((await worker.fetch(signed, { ...env, ACCESS_AUD: "" })).status).toBe(503);
    expect((await worker.fetch(signed.clone(), { ...env, ACCESS_TEAM_DOMAIN: "" })).status).toBe(503);
    const jwt = await token();
    for (const query of ["", "?from=", "?from=operator", "?from=not-a-node", `?node=${a}`]) {
      const refused = await api(`/api/messages/summary${query}`, jwt);
      expect(refused.status, query).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid from" });
    }
  });

  it("answers with the build and counts only: no message id, session, reason or text", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const ids = [...await seed(a, [{ state: "delivered", deletable: 1, created: NOW }, { state: "queued", deletable: null, created: NOW }]),
      ...await seed(b, [{ state: "refused", deletable: 1, created: NOW }])];
    const response = await api(`/api/messages/summary?from=${a}`, await token());
    expect(response.status).toBe(200);
    const raw = await response.text();
    for (const secret of [...ids, a, b, "secret-text", "secret-session", "secret-target", "secret-reason"]) expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as Record<string, unknown> & { groups: Record<string, unknown>[] };
    expect(Object.keys(body).sort()).toEqual(["commit", "fetchedAt", "groups", "rowsRead", "version"]);
    expect(body).toMatchObject({ version: rootPackage.version, commit: null, fetchedAt: expect.any(String) });
    expect(body.groups.map((g) => [g.state, g.deletable, g.count])).toEqual([["delivered", "1", 1], ["queued", "null", 1]]);
    for (const g of body.groups) {
      expect(Object.keys(g).sort()).toEqual(["age1to7d", "ageOver7d", "ageUnder24h", "count", "deletable", "state",
        "withDeadline"]);
    }
  });
});
