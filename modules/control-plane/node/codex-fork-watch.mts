import type { AppServerMessage } from "./codex-app-server-client.mts";
import type { ForkAttemptReason } from "./codex-fork-attempts.mts";

// The watch rules of one Codex fork attempt (issue #408, design section 4.4):
// every notification of the helper is kept in order and checked against what
// is known so far (the fork id, when turn/start was sent, the turn id). The
// first rule that fires is the attempt's reason; it never changes after that.
// Notifications that arrived before the fork or turn id was known are checked
// again once it is.

const FORK_ITEM_TYPES = ["userMessage", "agentMessage", "reasoning"];
const OWNER_TURN_METHODS = ["turn/started", "turn/completed", "thread/status/changed"];

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const paramsOf = (note: AppServerMessage): Record<string, unknown> => (object(note.params) ? note.params : {});

export class ForkWatch {
  readonly notifications: AppServerMessage[] = [];
  violation: ForkAttemptReason | null = null;
  private owner: string;
  private forkId: string | null = null;
  private turnId: string | null = null;
  private turnRequestedAt = -1;
  private listeners: (() => void)[] = [];

  constructor(owner: string) {
    this.owner = owner;
  }

  // Called after every notification and violation.
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((entry) => entry !== listener); };
  }

  add(note: AppServerMessage): void {
    this.check(note, this.notifications.push(note) - 1);
    this.changed();
  }

  // A server request was refused (-32601); no request is ever granted.
  refuse(reason: ForkAttemptReason): void {
    this.violation ??= reason;
    this.changed();
  }

  setFork(forkId: string): void {
    this.forkId = forkId;
    this.recheck();
  }

  turnRequested(): void {
    this.turnRequestedAt = this.notifications.length;
  }

  setTurn(turnId: string): void {
    this.turnId = turnId;
    this.recheck();
  }

  private recheck(): void {
    this.notifications.forEach((note, index) => this.check(note, index));
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private check(note: AppServerMessage, index: number): void {
    if (this.violation) return;
    const params = paramsOf(note), threadId = params.threadId;
    if (threadId === this.owner && (OWNER_TURN_METHODS.includes(note.method) || note.method.startsWith("item/"))) {
      this.violation = "unsolicited-turn";
      return;
    }
    if (this.forkId === null || threadId !== this.forkId) return;
    this.violation = this.forkRule(note.method, params, index);
  }

  private forkRule(method: string, params: Record<string, unknown>, index: number): ForkAttemptReason | null {
    if (method === "item/started" || method === "item/completed") {
      const type = object(params.item) ? params.item.type : undefined;
      return typeof type === "string" && FORK_ITEM_TYPES.includes(type) ? null : "tool-item";
    }
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") return "fork-goal";
    if (method === "turn/started") {
      if (this.turnRequestedAt < 0 || index < this.turnRequestedAt) return "unsolicited-turn";
      const id = object(params.turn) ? params.turn.id : undefined;
      return this.turnId !== null && id !== this.turnId ? "unsolicited-turn" : null;
    }
    if (method === "mcpServer/startupStatus/updated") return "mcp-started";
    if (method === "hook/started") return "hook-ran";
    return null;
  }
}
