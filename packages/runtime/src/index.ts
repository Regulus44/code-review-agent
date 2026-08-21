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

/** Coordinates sessions and turns while leaving storage, model and tools behind interfaces. */
export class AgentHost {
  private readonly model: ChatModel;
  private readonly systemPrompt: string;
  private readonly controllers = new Map<TurnId, AbortController>();

  constructor(private readonly options: AgentHostOptions) {
    this.model = options.model ?? new EchoChatModel();
    this.systemPrompt = options.systemPrompt ?? "You are a helpful coding agent.";
  }

  async createSession(workspaceRoot: string): Promise<SessionProjection> {
    const id = await this.options.store.createSession(workspaceRoot);
    const projection = await this.options.store.project(id);
    if (projection === undefined) throw new Error("Session projection was not created");
    return projection;
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return this.options.store.listSessions();
  }

  async getSession(sessionId: SessionId): Promise<SessionProjection | undefined> {
    return this.options.store.project(sessionId);
  }

  async events(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    return this.options.store.list(sessionId, afterSequence);
  }

  subscribe(sessionId: SessionId, listener: (event: AgentEvent) => void): () => void {
    return this.options.store.subscribe(sessionId, listener);
  }

  async sendMessage(sessionId: SessionId, content: string): Promise<TurnId> {
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (content.trim() === "") throw new Error("Message content cannot be empty");
    const turnId = brand<string, "TurnId">(`turn_${randomUUID()}`);
    await this.options.store.append({
      sessionId,
      turnId,
      type: "user/message",
      payload: { content },
    });
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    void this.runTurn(sessionId, turnId, controller, projection.messages, content).catch(() => undefined);
    return turnId;
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId): Promise<boolean> {
    const controller = this.controllers.get(turnId);
    if (controller === undefined) return false;
    controller.abort(new Error("Cancelled by user"));
    await this.options.store.append({
      sessionId,
      turnId,
      type: "agent/status",
      payload: { status: "stopped" },
    });
    return true;
  }

  async waitForTurn(turnId: TurnId, timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (this.controllers.has(turnId)) {
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${turnId}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
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
          await this.options.store.append({
            sessionId,
            turnId,
            type: "assistant/chunk",
            payload: { text: part.text },
          });
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      await this.options.store.append({
        sessionId,
        turnId,
        type: "assistant/message",
        payload: { content: assistant },
      });
      await this.options.store.append({
        sessionId,
        turnId,
        type: "turn/ended",
        payload: { status: "completed" },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await this.options.store.append({
          sessionId,
          turnId,
          type: "turn/ended",
          payload: { status: "stopped" },
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.store.append({
          sessionId,
          turnId,
          type: "agent/error",
          payload: { message },
        });
        await this.options.store.append({
          sessionId,
          turnId,
          type: "turn/ended",
          payload: { status: "failed", message },
        });
      }
    } finally {
      this.controllers.delete(turnId);
    }
  }
}

export function sessionId(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

export function turnId(value: string): TurnId {
  return brand<string, "TurnId">(value);
}
