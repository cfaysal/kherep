// Kherep Control Plane messaging bodies, Phase 2 step 1 (GitHub issue #31).
// Session-to-session messages between nodes, routed and queued by the Worker.
// Plain ECMAScript like protocol.mts, so the Worker and the node load it alike.

import { isNodeId } from "./protocol.mts";

// A node advertises this capability when it can take message.deliver. The
// Worker routes only to nodes that registered it.
export const MESSAGING_CAPABILITY = "messaging.v1";

// The sender node id of a message that an operator sent through the API.
export const OPERATOR_NODE_ID = "operator";

export const MAX_MESSAGE_TEXT = 16_384;
export const MAX_SESSION_REF = 128;
export const MAX_STATUS_REASON = 256;

export const MESSAGE_STATES = ["queued", "accepted", "delivered", "replied", "expired", "refused"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

// The states a node may report. queued and expired are set by the Worker only.
export const NODE_REPORTED_STATES = ["accepted", "delivered", "replied", "refused"] as const;
export type NodeReportedState = (typeof NODE_REPORTED_STATES)[number];

// session is a session id or a session name on that node.
export interface MessageAddress { nodeId: string; session: string }
// node -> Worker. The sender node is always the authenticated connection;
// the body has no field for it.
export interface MessageSendBody { messageId: string; fromSession: string; to: MessageAddress; text: string; inReplyTo?: string }
// Worker -> target node.
export interface MessageDeliverBody {
  messageId: string; from: MessageAddress; toSession: string; text: string; inReplyTo?: string; createdAt: string;
}
// node -> Worker (target reports progress) and Worker -> sending node.
export interface MessageStatusBody { messageId: string; state: MessageState; reason?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isSessionRef(value: unknown): value is string {
  return isText(value, MAX_SESSION_REF);
}

export function isMessageText(value: unknown): value is string {
  return isText(value, MAX_MESSAGE_TEXT);
}

export function isMessageState(value: unknown): value is MessageState {
  return (MESSAGE_STATES as readonly unknown[]).includes(value);
}

export function isNodeReportedState(value: unknown): value is NodeReportedState {
  return (NODE_REPORTED_STATES as readonly unknown[]).includes(value);
}

// allowOperator admits the literal "operator" as nodeId, which only
// API-originated messages carry as their sender.
export function isMessageAddress(value: unknown, allowOperator = false): value is MessageAddress {
  return isObject(value) && (isNodeId(value.nodeId) || (allowOperator && value.nodeId === OPERATOR_NODE_ID))
    && isSessionRef(value.session);
}

function isOptionalReplyTo(value: unknown): boolean {
  return value === undefined || isMessageId(value);
}

export function isMessageSendBody(body: unknown): body is MessageSendBody {
  return isObject(body) && isMessageId(body.messageId) && isSessionRef(body.fromSession) && isMessageAddress(body.to)
    && isMessageText(body.text) && isOptionalReplyTo(body.inReplyTo);
}

export function isMessageDeliverBody(body: unknown): body is MessageDeliverBody {
  return isObject(body) && isMessageId(body.messageId) && isMessageAddress(body.from, true) && isSessionRef(body.toSession)
    && isMessageText(body.text) && isOptionalReplyTo(body.inReplyTo)
    && typeof body.createdAt === "string" && !Number.isNaN(Date.parse(body.createdAt));
}

export function isMessageStatusBody(body: unknown): body is MessageStatusBody {
  return isObject(body) && isMessageId(body.messageId) && isMessageState(body.state)
    && (body.reason === undefined || isText(body.reason, MAX_STATUS_REASON));
}

// A status as a node may send it: only the node-reportable states.
export function isNodeMessageStatusBody(body: unknown): body is MessageStatusBody & { state: NodeReportedState } {
  return isMessageStatusBody(body) && isNodeReportedState(body.state);
}
