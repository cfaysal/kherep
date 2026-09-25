import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { enrollWithCode, newKey, registry } from "./helpers.mts";

describe("enrollment codes", () => {
  it("binds a node to its public key exactly once per code", async () => {
    const { code } = await registry().createEnrollment("test");
    const first = await enrollWithCode(code, await newKey());
    expect(first.status).toBe(201);
    const { nodeId } = await first.json() as { nodeId: string };
    expect((await registry().getNode(nodeId))?.runtimes).toEqual([{ name: "claude", kind: "cli" }]);

    const second = await enrollWithCode(code, await newKey(), "node-b");
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: "used-code" });
  });

  it("refuses an expired code", async () => {
    const { code, expiresAt } = await registry().createEnrollment("test", 60);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE enrollments SET expires_at = ? WHERE used_at IS NULL", Date.now() - 1);
    });
    const response = await enrollWithCode(code, await newKey());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "expired-code" });
  });

  it("clamps the TTL to the allowed range", async () => {
    const short = await registry().createEnrollment("test", 1);
    expect(short.expiresAt - Date.now()).toBeGreaterThan(55_000);
    const long = await registry().createEnrollment("test", 999_999);
    expect(long.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
  });

  it("refuses an unknown code and stores only code hashes", async () => {
    const response = await enrollWithCode("A".repeat(22), await newKey());
    expect(response.status).toBe(403);
    const { code } = await registry().createEnrollment("test");
    const stored = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT code_hash FROM enrollments").toArray().map((row) => row.code_hash));
    expect(stored).not.toContain(code);
  });

  it("refuses a malformed public key", async () => {
    const { code } = await registry().createEnrollment("test");
    const response = await enrollWithCode(code, { publicKey: "not-a-key", privateKey: (await newKey()).privateKey });
    expect(response.status).toBe(400);
  });
});
