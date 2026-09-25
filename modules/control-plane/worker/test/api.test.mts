import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src/index.mts";
import { BASE, enroll, newKey, workerFetch } from "./helpers.mts";

const TEAM = "https://team.example.com";
const AUD = "test-audience";
let signingKey: JoseKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  // Stand-in for <team domain>/cdn-cgi/access/certs; nothing leaves the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    return new Response("unexpected fetch", { status: 599 });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function token(claims: { iss?: string; aud?: string; email?: string } = {}): Promise<string> {
  return new SignJWT({ email: claims.email ?? "operator@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function api(path: string, init: RequestInit = {}, jwt?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jwt) headers.set("cf-access-jwt-assertion", jwt);
  return workerFetch(path, { ...init, headers });
}

describe("health", () => {
  it("answers without authentication", async () => {
    expect((await workerFetch("/health")).status).toBe(200);
  });
});

describe("Access JWT on /api/*", () => {
  it("rejects a request without the Access header", async () => {
    expect((await api("/api/nodes")).status).toBe(403);
  });

  it("rejects a malformed token", async () => {
    expect((await api("/api/nodes", {}, "not.a.jwt")).status).toBe(403);
  });

  it("rejects a token for another audience or issuer", async () => {
    expect((await api("/api/nodes", {}, await token({ aud: "other" }))).status).toBe(403);
    expect((await api("/api/nodes", {}, await token({ iss: "https://other.example.com" }))).status).toBe(403);
  });

  it("fails closed when the Access configuration is missing", async () => {
    const request = new Request(`${BASE}/api/nodes`, { headers: { "cf-access-jwt-assertion": await token() } });
    expect((await worker.fetch(request, { ...env, ACCESS_AUD: "" })).status).toBe(503);
    expect((await worker.fetch(request.clone(), { ...env, ACCESS_TEAM_DOMAIN: "" })).status).toBe(503);
  });

  it("accepts a valid token", async () => {
    const response = await api("/api/nodes", {}, await token());
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("nodes");
  });

  it("does not require Access on the node endpoints", async () => {
    expect((await workerFetch("/node/enroll", { method: "POST", body: "{}" })).status).toBe(400);
  });
});

describe("operator API", () => {
  it("creates enrollment codes and lists enrolled nodes", async () => {
    const jwt = await token();
    const created = await api("/api/enrollments", { method: "POST", body: JSON.stringify({ ttlSeconds: 120 }) }, jwt);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ code: expect.any(String), expiresAt: expect.any(Number) });
    const nodeId = await enroll(await newKey(), "listed-node");
    const detail = await api(`/api/nodes/${nodeId}`, {}, jwt);
    expect(await detail.json()).toMatchObject({ node: { id: nodeId, name: "listed-node" }, commands: [] });
    expect((await api("/api/sessions", {}, jwt)).status).toBe(200);
  });

  it("only dispatches the three Phase 1 commands", async () => {
    const jwt = await token();
    const nodeId = await enroll(await newKey());
    const post = (command: string) => api(`/api/nodes/${nodeId}/commands`, { method: "POST", body: JSON.stringify({ command }) }, jwt);
    for (const command of ["node.status", "runtime.list", "session.list"]) expect((await post(command)).status).toBe(202);
    for (const command of ["session.start", "shell.exec", "", "NODE.STATUS"]) {
      const refused = await post(command);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "command not allowed" });
    }
  });

  it("revokes a node and refuses further commands", async () => {
    const jwt = await token();
    const nodeId = await enroll(await newKey());
    expect((await api(`/api/nodes/${nodeId}`, { method: "DELETE" }, jwt)).status).toBe(200);
    expect((await api(`/api/nodes/${nodeId}`, { method: "DELETE" }, jwt)).status).toBe(404);
    const refused = await api(`/api/nodes/${nodeId}/commands`, { method: "POST", body: JSON.stringify({ command: "node.status" }) }, jwt);
    expect(refused.status).toBe(409);
  });
});
