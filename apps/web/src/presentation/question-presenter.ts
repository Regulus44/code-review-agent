import type { InteractionProjection, InteractionStatus } from "@code-review-agent/contracts";

export interface QuestionRenderIntent {
  readonly id: string;
  readonly question: string;
  readonly status: InteractionStatus;
  readonly statusLabel: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly allowFreeform: boolean;
  readonly canAnswer: boolean;
  readonly canCancel: boolean;
  readonly recovery: "pending" | "restored" | "resolved";
  readonly expiresAt: string;
  readonly answer?: string;
}

export interface QuestionBatchRenderIntent {
  readonly visible: boolean;
  readonly batchId?: string;
  readonly questions: readonly QuestionRenderIntent[];
  readonly pendingCount: number;
  readonly resolvedCount: number;
  readonly expiredCount: number;
  readonly title: string;
  readonly summary: string;
}

export function presentQuestionBatch(
  interactions: readonly InteractionProjection[] | undefined,
  options: { readonly batchId?: string; readonly now?: number; readonly maxQuestions?: number; readonly restoredIds?: ReadonlySet<string> } = {},
): QuestionBatchRenderIntent {
  const source = (interactions ?? []).filter((item) => options.batchId === undefined || String(item.turnId ?? "standalone") === options.batchId);
  const questions = source.slice(-Math.max(1, Math.floor(options.maxQuestions ?? 16))).map((item) => {
    const status = effectiveStatus(item, options.now ?? Date.now());
    const recovery: QuestionRenderIntent["recovery"] = status === "pending" && options.restoredIds?.has(String(item.id)) === true ? "restored" : status === "pending" ? "pending" : "resolved";
    return {
      id: String(item.id),
      question: bounded(item.question, 500),
      status,
      statusLabel: status === "pending" ? "待回答" : status === "answered" ? "已回答" : status === "cancelled" ? "已取消" : "已过期",
      options: item.options.slice(0, 16).map((option) => ({ label: bounded(option.label, 120), value: bounded(option.value, 240) })),
      allowFreeform: item.allowFreeform,
      canAnswer: status === "pending",
      canCancel: status === "pending",
      recovery,
      expiresAt: item.expiresAt,
      ...(item.answer === undefined ? {} : { answer: bounded(item.answer, 500) }),
    };
  });
  const pendingCount = questions.filter((item) => item.status === "pending").length;
  const resolvedCount = questions.filter((item) => item.status === "answered" || item.status === "cancelled").length;
  const expiredCount = questions.filter((item) => item.status === "expired").length;
  return {
    visible: questions.length > 0,
    ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
    questions,
    pendingCount,
    resolvedCount,
    expiredCount,
    title: pendingCount > 0 ? "智能体问题" : "问题历史",
    summary: `${pendingCount} 待处理 · ${resolvedCount} 已解决 · ${expiredCount} 已过期`,
  };
}

function effectiveStatus(item: InteractionProjection, now: number): InteractionStatus {
  if (item.status === "pending" && Date.parse(item.expiresAt) <= now) return "expired";
  return item.status;
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const limit = Math.max(24, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
