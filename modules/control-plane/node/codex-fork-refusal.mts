import crypto from "node:crypto";

import type { AppServerRequestError } from "./codex-app-server-client.mts";

// Issue #477: a JSON-RPC error response to one request of a fork attempt as one
// local log line of content-free metadata. No character of the server's message
// reaches the line: it names the method, the code if it is an integer, a fixed
// shape marker, the first 12 hex of the SHA-256 of the message's UTF-8 bytes,
// and which strings the attempt already holds the message contains. Nothing is
// persisted, and the code names no cause by itself.

export const FORK_RPC_METHODS = ["initialize", "thread/read", "thread/turns/list", "thread/fork"] as const;
export type ForkRpcMethod = typeof FORK_RPC_METHODS[number];
const MENTIONS = ["owner", "turn", "cwd", "codex-home", "kherep"] as const;
export const FORK_RPC_OVERLONG_BYTES = 4096;
export interface ForkRpcContext { owner: string; cwd: string; producer: { resolvedCodexHome: string } }

export function forkRpcError(method: ForkRpcMethod, error: Pick<AppServerRequestError, "code" | "rawMessage">, ctx: ForkRpcContext,
  lastTurnId?: string): { line: string } {
  if (!FORK_RPC_METHODS.includes(method)) throw new TypeError("not a fork RPC method");
  const message = error.rawMessage;
  const text = typeof message === "string" ? message : "";
  const code = Number.isInteger(error.code) ? String(error.code) : "none";
  const shape = typeof message !== "string" ? "missing" : message === "" ? "empty"
    : Buffer.byteLength(message, "utf8") > FORK_RPC_OVERLONG_BYTES ? "overlong" : "text";
  const sha256 = crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  // Tests against strings the attempt already holds, without case; an empty one matches nothing.
  const lower = text.toLowerCase();
  const has = (...needles: (string | undefined)[]): boolean => needles.some((needle) => !!needle && lower.includes(needle.toLowerCase()));
  const found: Record<typeof MENTIONS[number], boolean> = {
    owner: has(ctx.owner), turn: has(lastTurnId),
    cwd: has(ctx.cwd, ctx.cwd.replaceAll("\\", "/"), ctx.cwd.replaceAll("/", "\\")),
    "codex-home": has(ctx.producer.resolvedCodexHome), kherep: has("kherep"),
  };
  const mentions = MENTIONS.filter((mention) => found[mention]).join(",") || "none";
  return { line: `kherep-node: Codex fork helper refused ${method} (code ${code}, ${shape}, sha256 ${sha256}, mentions ${mentions})` };
}
