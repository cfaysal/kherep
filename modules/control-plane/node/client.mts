import {
  isCommandBody, makeEnvelope, parseEnvelope, PONG_FRAME, type ChallengeBody, type Envelope, type MessageType,
  type NodeFacts, type Phase1Command, type RuntimeInfo, type SessionInfo,
} from "../protocol.mts";
import { isMessageDeliverBody, type MessageDeliverBody } from "../protocol-messages.mts";
import { signChallenge, type NodeIdentity } from "./identity.mts";
import { acceptsMessage, advertisedCapabilities, isAllowed, type NodePolicy } from "./policy.mts";

export type CommandHandlers = Record<Phase1Command, () => Promise<unknown>>;

export interface ClientOptions {
  nodeId: string;
  identity: NodeIdentity;
  policy: NodePolicy;
  handlers: CommandHandlers;
  facts: () => NodeFacts;
  runtimes: () => Promise<RuntimeInfo[]>;
  // Rejects when the listing failed, which is not the same as no sessions.
  sessions: () => Promise<SessionInfo[]>;
  // Stores an accepted message in the node inbox; throws when it cannot.
  storeMessage: (body: MessageDeliverBody) => void;
  log?: (line: string) => void;
  now?: () => number;
}

// The node side of the protocol as a transport-free state machine: it takes
// one received frame and returns the frames to send. The daemon owns the
// socket; tests drive this class directly.
export class NodeClient {
  private readonly options: ClientOptions;
  private seq = 0;
  // Highest command seq processed. Survives reconnects within this process so
  // the auth message tells the server what not to resend.
  private processedSeq = 0;
  // The session list last sent in sessions.snapshot, as JSON.
  private lastSnapshot: string | null = null;
  authenticated = false;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  get ack(): number {
    return this.processedSeq;
  }

  connectionClosed(): void {
    this.authenticated = false;
  }

  async onFrame(raw: string): Promise<string[]> {
    if (raw === PONG_FRAME) return [];
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return [];
    const envelope = parsed.envelope;
    switch (envelope.type) {
      case "challenge":
        return [this.frame("auth", this.authBody(envelope.body as unknown as ChallengeBody), false)];
      case "event":
        if ((envelope.body as { name?: unknown }).name !== "auth.ok") return [];
        this.authenticated = true;
        this.lastSnapshot = null;
        return [
          this.frame("register", { facts: this.options.facts(), runtimes: await this.options.runtimes(), capabilities: advertisedCapabilities(this.options.policy) }),
          ...await this.sessionsSnapshot(),
        ];
      case "command":
        return this.authenticated ? this.onCommand(envelope) : [];
      case "message.deliver":
        if (!this.authenticated || !isMessageDeliverBody(envelope.body)) return [];
        return this.onDeliver(envelope.body);
      default:
        return [];
    }
  }

  // A sessions.snapshot frame when the session list changed since the last
  // one sent on this connection. A failed listing sends nothing, so the
  // Registry keeps its last known list instead of being wiped.
  async sessionsSnapshot(): Promise<string[]> {
    if (!this.authenticated) return [];
    let sessions: SessionInfo[];
    try {
      sessions = await this.options.sessions();
    } catch (error) {
      this.options.log?.(`kherep-node: session listing failed, snapshot skipped: ${String((error as Error).message ?? error)}`);
      return [];
    }
    const json = JSON.stringify(sessions);
    if (json === this.lastSnapshot) return [];
    this.lastSnapshot = json;
    return [this.frame("sessions.snapshot", { sessions })];
  }

  // Refused unless the local policy accepts this sender for this session.
  // A message that cannot be stored gets no answer, so the Worker keeps it
  // queued and delivers it again after the next authentication.
  private onDeliver(body: MessageDeliverBody): string[] {
    const { messageId } = body;
    if (!acceptsMessage(this.options.policy, body.toSession, body.from.nodeId)) {
      return [this.frame("message.status", { messageId, state: "refused", reason: "not accepted by node policy" })];
    }
    try {
      this.options.storeMessage(body);
    } catch (error) {
      this.options.log?.(`kherep-node: could not store message ${messageId}: ${String((error as Error).message ?? error)}`);
      return [];
    }
    return [this.frame("message.status", { messageId, state: "accepted" })];
  }

  private authBody(challenge: ChallengeBody): Record<string, unknown> {
    const now = this.options.now?.() ?? Date.now();
    return { ...signChallenge(this.options.identity, this.options.nodeId, challenge.nonce, now) };
  }

  private async onCommand(envelope: Envelope): Promise<string[]> {
    if (!isCommandBody(envelope.body)) return [];
    const { commandId, command } = envelope.body;
    // At-least-once delivery: a resent command that was already processed is
    // only acknowledged again, never executed twice.
    if (envelope.seq <= this.processedSeq) return [this.frame("command.ack", { commandId })];
    this.processedSeq = envelope.seq;
    const out = [this.frame("command.ack", { commandId })];
    if (!isAllowed(this.options.policy, command)) {
      out.push(this.frame("command.result", { commandId, ok: false, error: "rejected by local policy" }));
      return out;
    }
    try {
      const result = await this.options.handlers[command]();
      out.push(this.frame("command.result", { commandId, ok: true, result }));
    } catch (error) {
      out.push(this.frame("command.result", { commandId, ok: false, error: String((error as Error).message ?? error).slice(0, 1024) }));
    }
    return out;
  }

  private frame(type: MessageType, body: Record<string, unknown>, sequenced = true): string {
    return JSON.stringify(makeEnvelope(type, body, sequenced ? ++this.seq : 0, this.processedSeq));
  }
}
