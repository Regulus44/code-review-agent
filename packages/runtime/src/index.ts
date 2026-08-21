import {
  brand,
  type AgentEvent,
  type ChatMessage,
  type ChatModel,
  type SessionEventStore,
  type SessionId,
  type SessionProjection,
  type SessionSummary,
  type TurnId,
} from "@code-review-agent/contracts";
import { EchoChatModel } from "@code-review-agent/llm";
import { randomUUID } from "node:crypto";

export interface AgentHostOptions {
  readonly store: SessionEventStore;
  readonly model?: ChatModel;
  readonly systemPrompt?: string;
}

interface PendingTurn {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly content: string;
  readonly previousMessages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

/** Coordinates durable sessions, queued turns and model execution behind storage/model interfaces. */
export class AgentHost {
  private readonly model: ChatModel;
  private readonly systemPrompt: string;
  private readonly controllers = new Map<TurnId, AbortController>();
  private readonly activeTurns = new Map<SessionId, TurnId>();
  private readonly queues = new Map<SessionId, PendingTurn[]>();
  private readonly ready: Promise<void>;

  constructor(private readonly options: AgentHostOptions) {
    this.model = options.model ?? new EchoChatModel();
    this.systemPrompt = options.systemPrompt ?? "You are a helpful coding agent.";
    this.ready = this.restoreQueuedTurns();
  }

  async createSession(workspaceRoot: string): Promise<SessionProjection> {
    await this.ready;
    const id = await this.options.store.createSession(workspaceRoot);
    const projection = await this.options.store.project(id);
    if (projection === undefined) throw new Error("Session projection was not created");
    return projection;
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    await this.ready;
    return this.options.store.listSessions();
  }

  async getSession(sessionId: SessionId): Promise<SessionProjection | undefined> {
    await this.ready;
    return this.options.store.project(sessionId);
  }

  async events(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    await this.ready;
    return this.options.store.list(sessionId, afterSequence);
  }

  subscribe(sessionId: SessionId, listener: (event: AgentEvent) => void): () => void {
    return this.options.store.subscribe(sessionId, listener);
  }

  async sendMessage(sessionId: SessionId, content: string, commandId?: string): Promise<TurnId> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (content.trim() === "") throw new Error("Message content cannot be empty");

    const turnId = brand<string, "TurnId">(`turn_${randomUUID()}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "send_message",
      request: { content },
      result: { turnId },
    });
    if (!claim.created) {
      const savedTurnId = (claim.record.result as { turnId?: unknown }).turnId;
      if (typeof savedTurnId !== "string") throw new Error(`Command ${idempotencyKey} has an invalid result`);
      return turnIdFrom(savedTurnId);
    }

    const pending: PendingTurn = {
      sessionId,
      turnId,
      content,
      previousMessages: projection.messages,
    };
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "user/message",
      payload: { content },
    });
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "turn/queued",
      payload: { commandId: idempotencyKey },
    });
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    void this.drainSession(sessionId);
    return turnId;
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId, commandId?: string): Promise<boolean> {
    await this.ready;
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const cancellationRequested = this.controllers.has(turnId) || (this.queues.get(sessionId)?.some((item) => item.turnId === turnId) ?? false);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "cancel_turn",
      request: { turnId },
      result: { cancelled: cancellationRequested },
    });
    if (!claim.created) return Boolean((claim.record.result as { cancelled?: unknown }).cancelled);
    if (!cancellationRequested) return false;

    const controller = this.controllers.get(turnId);
    if (controller === undefined) this.removeQueuedTurn(sessionId, turnId);
    if (controller !== undefined) controller.abort(new Error("Cancelled by user"));
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "agent/status",
      payload: { status: "stopped", reason: "cancelled_by_user" },
    });
    if (controller === undefined) {
      await this.options.store.append({
        sessionId,
        turnId,
        correlationId: idempotencyKey,
        type: "turn/ended",
        payload: { status: "stopped" },
      });
      void this.drainSession(sessionId);
    }
    return true;
  }

  async resumeSession(sessionId: SessionId, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resume_session",
      request: {},
      result: { resumed: true },
    });
    if (claim.created && (projection.status === "interrupted" || projection.status === "stopped")) {
      await this.options.store.append({
        sessionId,
        correlationId: idempotencyKey,
        type: "agent/status",
        payload: { status: "idle", reason: "resumed_by_user" },
      });
    }
    void this.drainSession(sessionId);
    const resumed = await this.options.store.project(sessionId);
    if (resumed === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return resumed;
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, commandId?: string): Promise<SessionId> {
    await this.ready;
    const source = await this.options.store.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const forkedId = brand<string, "SessionId">(`ses_${randomUUID()}`);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "fork_session",
      request: { workspaceRoot },
      result: { sessionId: forkedId },
    });
    if (!claim.created) {
      const savedId = (claim.record.result as { sessionId?: unknown }).sessionId;
      if (typeof savedId !== "string") throw new Error(`Command ${idempotencyKey} has an invalid result`);
      return sessionIdFrom(savedId);
    }
    return this.options.store.forkSession(sessionId, workspaceRoot, forkedId);
  }

  async waitForTurn(turnId: TurnId, timeoutMs = 10_000): Promise<void> {
    await this.ready;
    const started = Date.now();
    while (true) {
      const sessions = await this.options.store.listSessions();
      for (const session of sessions) {
        const projection = await this.options.store.project(session.id);
        const turn = projection?.turns.find((item) => item.id === turnId);
        if (turn !== undefined && turn.status !== "queued" && turn.status !== "running") return;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${turnId}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private async restoreQueuedTurns(): Promise<void> {
    for (const summary of await this.options.store.listSessions()) {
      const projection = await this.options.store.project(summary.id);
      if (projection === undefined) continue;
      for (const turn of projection.turns.filter((item) => item.status === "queued" && item.userMessage !== undefined)) {
        const messageIndex = projection.messages.findIndex((message) => message.turnId === turn.id && message.role === "user");
        this.enqueue({
          sessionId: summary.id,
          turnId: turn.id,
          content: turn.userMessage as string,
          previousMessages: messageIndex < 0 ? projection.messages : projection.messages.slice(0, messageIndex),
        });
      }
    }
  }

  private enqueue(pending: PendingTurn): void {
    const queue = this.queues.get(pending.sessionId) ?? [];
    if (!queue.some((item) => item.turnId === pending.turnId)) queue.push(pending);
    this.queues.set(pending.sessionId, queue);
  }

  private removeQueuedTurn(sessionId: SessionId, turnId: TurnId): PendingTurn | undefined {
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return undefined;
    const index = queue.findIndex((item) => item.turnId === turnId);
    if (index < 0) return undefined;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(sessionId);
    return removed;
  }

  private async drainSession(sessionId: SessionId): Promise<void> {
    if (this.activeTurns.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    const pending = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.queues.delete(sessionId);
    if (pending === undefined) return;
    const controller = new AbortController();
    this.activeTurns.set(sessionId, pending.turnId);
    this.controllers.set(pending.turnId, controller);
    void this.runTurn(sessionId, pending.turnId, controller, pending.previousMessages, pending.content).finally(() => {
      this.controllers.delete(pending.turnId);
      this.activeTurns.delete(sessionId);
      void this.drainSession(sessionId);
    });
  }

  private async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    previousMessages: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
    content: string,
  ): Promise<void> {
    try {
      await this.options.store.append({ sessionId, turnId, type: "turn/started", payload: {} });
      const messages: ChatMessage[] = [
        { role: "system", content: this.systemPrompt },
        ...previousMessages.map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content },
      ];
      let assistant = "";
      for await (const part of this.model.stream({ messages, signal: controller.signal })) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
        if (part.type === "text_delta") {
          assistant += part.text;
          await this.options.store.append({ sessionId, turnId, type: "assistant/chunk", payload: { text: part.text } });
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      await this.options.store.append({ sessionId, turnId, type: "assistant/message", payload: { content: assistant } });
      await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "completed" } });
    } catch (error) {
      if (controller.signal.aborted) {
        await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "stopped" } });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.store.append({ sessionId, turnId, type: "agent/error", payload: { message } });
        await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "failed", message } });
      }
    }
  }
}

export function sessionId(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

export function turnId(value: string): TurnId {
  return brand<string, "TurnId">(value);
}

function sessionIdFrom(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

function turnIdFrom(value: string): TurnId {
  return brand<string, "TurnId">(value);
}
