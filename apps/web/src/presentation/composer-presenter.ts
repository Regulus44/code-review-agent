export type ComposerSubmitMode = "send" | "stop" | "stopping";

export interface ComposerTurnLike {
  readonly id: string;
  readonly status: "queued" | "running" | "completed" | "stopped" | "failed" | "interrupted" | string;
}

export interface ComposerSubmitInput {
  readonly turn?: ComposerTurnLike;
  readonly stoppingTurnId?: string | null;
  readonly inputHasContent: boolean;
  readonly bootReady: boolean;
}

export interface ComposerSubmitView {
  readonly mode: ComposerSubmitMode;
  readonly icon: string;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly title: string;
}

export function presentComposerSubmit(input: ComposerSubmitInput): ComposerSubmitView {
  const turn = input.turn?.status === "queued" || input.turn?.status === "running" ? input.turn : undefined;
  const stopping = turn !== undefined && input.stoppingTurnId === turn.id;
  const mode: ComposerSubmitMode = stopping ? "stopping" : turn === undefined ? "send" : "stop";
  const disabled = !input.bootReady || mode === "stopping" || (mode === "send" && !input.inputHasContent);
  const queued = turn?.status === "queued";
  return {
    mode,
    icon: mode === "send" ? "↑" : mode === "stop" ? "■" : "…",
    disabled,
    ariaLabel: mode === "send" ? "Send message" : mode === "stop" ? queued ? "Stop queued turn" : "Stop running turn" : "Stopping turn",
    title: mode === "send" ? "Send message" : mode === "stop" ? "Stop current turn" : "Stopping current turn",
  };
}
