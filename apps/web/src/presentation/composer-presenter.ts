export type ComposerSubmitMode = "send" | "stop" | "stopping" | "submitting";

export interface ComposerTurnLike {
  readonly id: string;
  readonly status: "queued" | "running" | "completed" | "stopped" | "failed" | "interrupted" | string;
}

export interface ComposerSubmitInput {
  readonly turn?: ComposerTurnLike;
  readonly stoppingTurnId?: string | null;
  readonly inputHasContent: boolean;
  readonly bootReady: boolean;
  readonly pendingSubmit?: boolean;
}

export interface ComposerSubmitView {
  readonly mode: ComposerSubmitMode;
  readonly icon: string;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly title: string;
}

export function presentComposerSubmit(input: ComposerSubmitInput): ComposerSubmitView {
  if (input.pendingSubmit) {
    return { mode: "submitting", icon: "…", disabled: true, ariaLabel: "正在发送消息", title: "正在发送消息" };
  }
  const turn = input.turn?.status === "queued" || input.turn?.status === "running" ? input.turn : undefined;
  const stopping = turn !== undefined && input.stoppingTurnId === turn.id;
  const mode: ComposerSubmitMode = stopping ? "stopping" : turn === undefined ? "send" : "stop";
  const disabled = !input.bootReady || mode === "stopping" || (mode === "send" && !input.inputHasContent);
  const queued = turn?.status === "queued";
  return {
    mode,
    icon: mode === "send" ? "↑" : mode === "stop" ? "■" : "…",
    disabled,
    ariaLabel: mode === "send" ? "发送消息" : mode === "stop" ? queued ? "停止排队中的回合" : "停止正在运行的回合" : "正在停止回合",
    title: mode === "send" ? "发送消息" : mode === "stop" ? "停止当前回合" : "正在停止当前回合",
  };
}
