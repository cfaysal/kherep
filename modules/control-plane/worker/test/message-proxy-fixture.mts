import { runInDurableObject } from "cloudflare:test";

import { MESSAGE_STATUS_ACK, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { enroll, FACTS, newKey, registry, type NodeKey } from "./helpers.mts";

// Issue #408, PR 4: three enrolled messaging nodes, a peer's question to the
// owner's exact session, and proxy answers of it, straight through the Registry.

export const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
export const row = (id: string) => query((sql) => sql.exec(`SELECT state, reason, depth, in_reply_to, proxy_of, reply_message_id
  FROM messages WHERE id = ?`, id).toArray()[0]);
export const audits = (action: string) => query((sql) => sql.exec("SELECT detail FROM audit WHERE action = ?", action).toArray()
  .map((r) => JSON.parse(String(r.detail))));

export async function nodes() {
  const keys: Record<string, NodeKey> = {};
  const add = async (name: string): Promise<string> => {
    const key = await newKey();
    const id = await enroll(key, name);
    keys[id] = key;
    await registry().updateRegistration(id, FACTS, [], [MESSAGING_CAPABILITY]);
    return id;
  };
  const peer = await add("proxy-peer");
  const owner = await add("proxy-owner");
  const other = await add("proxy-other");
  const send = async (from: string, fromSession: string, to: string, toSession: string, lineage: { inReplyTo?: string; proxyOf?: string } = {}) => {
    const messageId = crypto.randomUUID();
    const result = await registry().sendMessage({ messageId, from: { nodeId: from, session: fromSession }, to: { nodeId: to, session: toSession },
      text: "synthetic", ...lineage }, `node:${from}`);
    return { messageId, result };
  };
  // The peer's question to the owner's exact session id, accepted by the owner node.
  const original = async () => {
    const { messageId } = await send(peer, "s-peer", owner, "s-owner");
    await registry().reportMessageStatus(owner, { messageId, state: "accepted" });
    return messageId;
  };
  const proxy = (proxyOf: string, from = owner, fromSession = "s-owner", to = peer, toSession = "s-peer") =>
    send(from, fromSession, to, toSession, { proxyOf });
  // The owner node's delivered report, then the peer's ack of it: the row goes, a tombstone stays.
  const deleteOriginal = async (id: string) => {
    await registry().reportMessageStatus(owner, { messageId: id, state: "delivered" });
    await registry().ackMessageStatus(peer, { name: MESSAGE_STATUS_ACK, messageId: id, state: "delivered" });
  };
  return { peer, owner, other, keys, send, original, proxy, deleteOriginal };
}
