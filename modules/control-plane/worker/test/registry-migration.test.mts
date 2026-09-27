import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ADDED_SESSION_COLUMNS, migrateRegistry } from "../src/registry-schema.mts";
import { enroll, newKey, registry } from "./helpers.mts";

const columns = (sql: SqlStorage) => sql.exec("PRAGMA table_info(sessions)").toArray().map((c) => String(c.name));

describe("Registry sessions migration", () => {
  it("adds name, cwd, kind, label and title to a sessions table from an earlier deployment, once", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      // The Phase 1 table, with a row that must survive.
      sql.exec("DROP TABLE sessions");
      sql.exec(`CREATE TABLE sessions (node_id TEXT NOT NULL, session_id TEXT NOT NULL, runtime TEXT NOT NULL, state TEXT NOT NULL,
        started_at TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (node_id, session_id))`);
      sql.exec("INSERT INTO sessions (node_id, session_id, runtime, state, updated_at) VALUES ('n', 's', 'claude', 'running', 1)");
      for (const column of ADDED_SESSION_COLUMNS) expect(columns(sql)).not.toContain(column);

      migrateRegistry(sql);
      expect(columns(sql)).toEqual(expect.arrayContaining([...ADDED_SESSION_COLUMNS]));
      // A second start finds the columns and changes nothing.
      migrateRegistry(sql);
      expect(columns(sql).length).toBe(11);
      expect(sql.exec("SELECT session_id, name, cwd, kind, label, title FROM sessions").toArray())
        .toEqual([{ session_id: "s", name: null, cwd: null, kind: null, label: null, title: null }]);
    });
  });

  it("stores and returns the new session fields, and omits them when absent", async () => {
    const nodeId = await enroll(await newKey());
    await registry().replaceSessions(nodeId, [
      { sessionId: "a", runtime: "claude-code", state: "running", name: "review", cwd: "/work/repo", kind: "interactive",
        label: "intercom: claude@sekhmet" },
      { sessionId: "b", runtime: "claude-code", state: "idle" },
      { sessionId: "c", runtime: "codex", state: "active", name: "codex-d7d07717", title: "Kherep-Funktionen nachschlagen" },
    ]);
    const mine = (await registry().listSessions()).filter((s) => s.nodeId === nodeId);
    expect(mine).toEqual([
      expect.objectContaining({ sessionId: "a", name: "review", cwd: "/work/repo", kind: "interactive", label: "intercom: claude@sekhmet" }),
      expect.not.objectContaining({ name: expect.anything() }),
      expect.objectContaining({ sessionId: "c", name: "codex-d7d07717", title: "Kherep-Funktionen nachschlagen" }),
    ]);
    expect(mine[1]).not.toHaveProperty("cwd");
    expect(mine[0]).not.toHaveProperty("title");
    // The directory frame nodes read carries the title (issue #88).
    const directory = await registry().directory();
    expect(directory.sessions.find((s) => s.sessionId === "c")).toMatchObject({ title: "Kherep-Funktionen nachschlagen" });
  });
});
