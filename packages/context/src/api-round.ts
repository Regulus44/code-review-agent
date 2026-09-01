import type { ChatMessage } from "@coding-agent/contracts";

export interface ApiRound {
  readonly index: number;
  readonly responseId?: string;
  readonly messages: readonly ChatMessage[];
}

/**
 * Groups messages by model response identity. A user turn can contain several
 * assistant/tool loops, so grouping deliberately does not use user messages
 * as the boundary.
 */
export function groupMessagesByApiRound(messages: readonly ChatMessage[]): readonly ApiRound[] {
  const rounds: ApiRound[] = [];
  let current: ChatMessage[] = [];
  let currentResponseId: string | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    rounds.push({
      index: rounds.length,
      ...(currentResponseId === undefined ? {} : { responseId: currentResponseId }),
      messages: current,
    });
    current = [];
  };

  for (const message of messages) {
    if (message.role === "assistant" && message.responseId !== undefined) {
      if (current.length > 0 && currentResponseId !== undefined && message.responseId !== currentResponseId) flush();
      currentResponseId = message.responseId;
    }
    current.push(message);
  }
  flush();
  return rounds;
}
