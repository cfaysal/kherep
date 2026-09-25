import {
  isCommandBody, makeEnvelope, parseEnvelope, PONG_FRAME, type ChallengeBody, type Envelope, type MessageType,
  type NodeFacts, type Phase1Command, type RuntimeInfo, type SessionCommand, type SessionInfo,
} from "../protocol.mts";
import {
  isCommandArgs, isTaskRequestResult, TASK_REQUEST_RESULT, type TaskReportBody, type TaskRequestBody, type TaskRequestResult,
} from "../protocol-tasks.mts";
import {
  isDirectoryBody, isMessageDeliverBody, isMessageId, isMessageStatusBody, type DirectoryBody, type MessageDeliverBody,
  type MessageSendBody, type MessageState,
} from "../protocol-messages.mts";
import { signChallenge, type NodeIdentity } from "./identity.mts";
import { acceptsMessage, advertisedCapabilities, isAllowed, type NodePolicy } from "./policy.mts";

// Session commands (item 5) take their validated args; a node without them
// answers ok:false.
export type CommandHandlers = Record<Phase1Command, () => Promise<unknown>>
  & Partial<Record<SessionCommand, (args: never) => Promise<unknown>>>;
// The state of a message this node sent: a Worker state, or error when the
// Worker rejected the message.send frame itself.
export type SentState = MessageState | "error";

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
  // The last local session listing (sessions.json), so a policy rule for a
  // session name also accepts a message addressed by that session's id.
  localSessions?: () => { sessionId: string; name?: string }[];
  // Step 3a: the directory frame, and the state of a message this node sent.
  storeDirectory?: (body: DirectoryBody) => void;
  sentUpdate?: (messageId: string, state: SentState, reason?: string) => void;
  // Item 5: the Worker's answer to a task.request this node sent.
  taskRequestResult?: (result: TaskRequestResult) => void;
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
        if ((envelope.body as { name?: unknown }).name === TASK_REQUEST_RESULT && this.authenticated) {
          const body = envelope.body;
          if (isTaskRequestResult(body)) this.callback(body.requestId, () => this.options.taskRequestResult?.(body));
          return [];
        }
        if ((envelope.body as { name?: unknown }).name !== "auth.ok") return [];
        this.authenticated = true;
        this.lastSnapshot = null;
        return [
          this.frame("register", { facts: this.options.facts(), runtimes: await this.options.runtimes(), capabilities: advertisedCapabilities(this.options.policy) }),
          ...await this.sessionsSnapshot(),
          ...this.directoryRequest(),
        ];
      case "command":
        return this.authenticated ? this.onCommand(envelope) : [];
      case "message.deliver":
        if (!this.authenticated || !isMessageDeliverBody(envelope.body)) return [];
        return this.onDeliver(envelope.body);
      case "directory":
        if (isDirectoryBody(envelope.body)) this.callback("directory", () => this.options.storeDirectory?.(envelope.body as DirectoryBody));
        return [];
      case "message.status": {
        const body = envelope.body;
        if (isMessageStatusBody(body)) this.callback(body.messageId, () => this.options.sentUpdate?.(body.messageId, body.state, body.reason));
        return [];
      }
      case "error": {
        // The Worker answers a message.send it cannot take with an error frame
        // that names the message.
        const { messageId, error } = envelope.body as { messageId?: unknown; error?: unknown };
        if (isMessageId(messageId)) this.callback(messageId, () => this.options.sentUpdate?.(messageId, "error", String(error).slice(0, 256)));
        return [];
      }
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

  directoryRequest(): string[] {
    return this.authenticated ? [this.frame("directory.get", {})] : [];
  }

  sendMessage(body: MessageSendBody): string[] {
    return this.authenticated ? [this.frame("message.send", { ...body, to: { ...body.to } })] : [];
  }

  // The state the target session reached: delivered, or refused with a reason.
  reportStatus(messageId: string, state: "delivered" | "refused", reason?: string): string[] {
    return this.authenticated ? [this.frame("message.status", { messageId, state, ...(reason ? { reason } : {}) })] : [];
  }

  reportTask(body: TaskReportBody): string[] {
    return this.authenticated ? [this.frame("task.report", { ...body })] : [];
  }

  requestTask(body: TaskRequestBody): string[] {
    const { requestId, title, text, requirements, directive, requestedBy } = body;
    return this.authenticated
      ? [this.frame("task.request", { requestId, title, text, requirements: { ...requirements }, directive, requestedBy })] : [];
  }

  // A failing local write is logged; the frame loop goes on.
  private callback(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.log?.(`kherep-node: could not record ${what}: ${String((error as Error).message ?? error)}`);
    }
  }

  // Refused unless the local policy accepts this sender for this session.
  // A message that cannot be stored gets no answer, so the Worker keeps it
  // queued and delivers it again after the next authentication.
  private onDeliver(body: MessageDeliverBody): string[] {
    const { messageId } = body;
    let local: { sessionId: string; name?: string }[] = [];
    try {
      local = this.options.localSessions?.() ?? [];
    } catch {
      // unreadable listing: only the addressed reference itself matches
    }
    if (!acceptsMessage(this.options.policy, body.toSession, body.from.nodeId, local)) {
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
    const { commandId, command, args } = envelope.body;
    // At-least-once delivery: a resent command that was already processed is
    // only acknowledged again, never executed twice.
    if (envelope.seq <= this.processedSeq) return [this.frame("command.ack", { commandId })];
    this.processedSeq = envelope.seq;
    const out = [this.frame("command.ack", { commandId })];
    if (!isAllowed(this.options.policy, command)) {
      out.push(this.frame("command.result", { commandId, ok: false, error: "rejected by local policy" }));
      return out;
    }
    const handler = this.options.handlers[command] as ((args?: unknown) => Promise<unknown>) | undefined;
    if (!isCommandArgs(command, args) || !handler) {
      out.push(this.frame("command.result", { commandId, ok: false, error: handler ? "invalid command arguments" : "command not supported" }));
      return out;
    }
    try {
      const result = await handler(args);
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
