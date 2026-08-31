import type { SessionStatsProjection } from "@code-review-agent/contracts";

export interface UsageSummary {
  readonly turnCount: number;
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly turnDurationMs?: number;
  readonly llmDurationMs?: number;
  readonly toolDurationMs?: number;
  readonly ttftMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly outputTokensPerSecond?: number;
  readonly cacheHitPercent?: number;
  readonly status?: string;
  readonly latestPrompt?: string;
}

export interface UsageDetail {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}

export interface UsageRenderIntent {
  readonly compactLabel: string;
  readonly title: string;
  readonly hasData: boolean;
  readonly summary: UsageSummary;
  readonly details: readonly UsageDetail[];
  readonly source: "projection" | "events";
  readonly complete: boolean;
}

export interface UsageEvent {
  readonly type: string;
  readonly turnId?: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function presentUsage(source: readonly UsageEvent[] | SessionStatsProjection): UsageRenderIntent {
  const projection = isSessionStatsProjection(source) ? source : undefined;
  const ordered = projection === undefined ? [...(source as readonly UsageEvent[])].sort((left, right) => left.sequence - right.sequence) : [];
  const summary = projection === undefined ? summarizeUsage(ordered) : summarizeStats(projection);
  const compactLabel = [
    `${summary.stepCount || "—"} 步`,
    `LLM ${formatDuration(summary.llmDurationMs)}`,
    `工具 ${summary.toolCallCount || "—"} 次`,
    `输入 ${formatTokens(summary.inputTokens)}`,
    `输出 ${formatTokens(summary.outputTokens)}`,
    `缓存 ${formatTokens(summary.cacheReadTokens)}`,
  ].join(" · ");
  const details: UsageDetail[] = [
    { label: "回合数", value: String(summary.turnCount) },
    { label: "步骤数", value: String(summary.stepCount) },
    { label: "回合耗时", value: formatDuration(summary.turnDurationMs) },
    { label: "LLM 耗时", value: formatDuration(summary.llmDurationMs), detail: "根据步骤开始到智能体响应事件推导。" },
    { label: "工具调用", value: `${summary.toolCallCount} · ${formatDuration(summary.toolDurationMs)}` },
    { label: "首 token", value: formatDuration(summary.ttftMs), detail: "优先使用提供方报告的 TTFT，否则根据首个智能体分片推导。" },
    { label: "输入 token", value: formatTokens(summary.inputTokens) },
    { label: "输出 token", value: formatTokens(summary.outputTokens) },
    { label: "总 token", value: formatTokens(summary.totalTokens) },
    { label: "推理 token", value: formatTokens(summary.reasoningTokens) },
    { label: "生成速度", value: summary.outputTokensPerSecond === undefined ? "—" : `${formatDecimal(summary.outputTokensPerSecond)} token/s` },
    { label: "缓存命中", value: summary.cacheHitPercent === undefined ? "—" : `${formatDecimal(summary.cacheHitPercent)}%` },
    { label: "最近提示", value: summary.latestPrompt === undefined ? "—" : truncatePrompt(summary.latestPrompt) },
    { label: "状态", value: localizeStatus(summary.status) },
  ];
  const hasData = projection === undefined
    ? ordered.some((event) => ["turn/queued", "turn/started", "step/started", "assistant/chunk", "assistant/message", "tool/call", "tool/result", "turn/ended"].includes(event.type))
    : projection.turnCount > 0 || projection.stepCount > 0 || projection.toolCallCount > 0 || projection.totalTokens !== undefined;
  return {
    compactLabel,
    title: projection === undefined
      ? "当前加载历史窗口中的运行时用量与耗时。提供方未知值显示为 —。"
      : `截至序列 ${projection.sourceSequence} 的完整会话日志中的运行时用量与耗时。提供方未知值显示为 —。`,
    hasData,
    summary,
    details,
    source: projection === undefined ? "events" : "projection",
    complete: projection?.complete === true,
  };
}

function localizeStatus(value: string | undefined): string {
  if (value === undefined) return "未知";
  return ({ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", canceled: "已取消", stopped: "已停止", interrupted: "已中断" } as Record<string, string>)[value] ?? value;
}

export function presentUsageProjection(projection: SessionStatsProjection): UsageRenderIntent {
  return presentUsage(projection);
}

function summarizeStats(projection: SessionStatsProjection): UsageSummary {
  return {
    turnCount: projection.turnCount,
    stepCount: projection.stepCount,
    toolCallCount: projection.toolCallCount,
    ...(projection.turnDurationMs === undefined ? {} : { turnDurationMs: projection.turnDurationMs }),
    ...(projection.llmDurationMs === undefined ? {} : { llmDurationMs: projection.llmDurationMs }),
    ...(projection.toolDurationMs === undefined ? {} : { toolDurationMs: projection.toolDurationMs }),
    ...(projection.ttftMs === undefined ? {} : { ttftMs: projection.ttftMs }),
    ...(projection.inputTokens === undefined ? {} : { inputTokens: projection.inputTokens }),
    ...(projection.outputTokens === undefined ? {} : { outputTokens: projection.outputTokens }),
    ...(projection.cacheReadTokens === undefined ? {} : { cacheReadTokens: projection.cacheReadTokens }),
    ...(projection.reasoningTokens === undefined ? {} : { reasoningTokens: projection.reasoningTokens }),
    ...(projection.totalTokens === undefined ? {} : { totalTokens: projection.totalTokens }),
    ...(projection.outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond: projection.outputTokensPerSecond }),
    ...(projection.cacheHitPercent === undefined ? {} : { cacheHitPercent: projection.cacheHitPercent }),
    ...(projection.status === undefined ? {} : { status: projection.status }),
    ...(projection.latestPrompt === undefined ? {} : { latestPrompt: projection.latestPrompt }),
  };
}

function isSessionStatsProjection(value: readonly UsageEvent[] | SessionStatsProjection): value is SessionStatsProjection {
  return !Array.isArray(value) && typeof value === "object" && value !== null && "version" in value && value.version === 1 && "turnCount" in value && "sourceSequence" in value;
}

function truncatePrompt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
}

export function summarizeUsage(events: readonly UsageEvent[]): UsageSummary {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const turns = new Set<string>();
  const turnStarts = new Map<string, number>();
  const turnDurations: number[] = [];
  const stepStarts = new Map<string, number[]>();
  const llmDurations: number[] = [];
  const toolStarts = new Map<string, number>();
  const toolDurations: number[] = [];
  const firstTurnStart = new Map<string, number>();
  const firstAssistant = new Map<string, number>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let status: string | undefined;
  let reportedTtft: number | undefined;

  for (const event of ordered) {
    const turnId = event.turnId === undefined ? undefined : String(event.turnId);
    if (turnId !== undefined) turns.add(turnId);
    const timestamp = eventTime(event);
    const payload = event.payload;
    const explicitTtft = finiteNumber(payload.ttftMs ?? payload.ttft_ms);
    if (shouldUseExplicitTtft(reportedTtft, explicitTtft)) reportedTtft = explicitTtft;
    if (event.type === "turn/started" && turnId !== undefined && timestamp !== undefined) {
      turnStarts.set(turnId, timestamp);
      firstTurnStart.set(turnId, timestamp);
    } else if (event.type === "turn/ended") {
      status = typeof payload.status === "string" ? payload.status : status;
      if (turnId !== undefined && timestamp !== undefined) {
        const started = turnStarts.get(turnId);
        if (started !== undefined && timestamp >= started) turnDurations.push(timestamp - started);
      }
    } else if (event.type === "step/started" && turnId !== undefined && timestamp !== undefined) {
      const key = `${turnId}:${String(payload.step ?? "")}`;
      stepStarts.set(key, [timestamp]);
    } else if (event.type === "assistant/chunk" || event.type === "assistant/message") {
      if (turnId !== undefined && timestamp !== undefined && !firstAssistant.has(turnId)) firstAssistant.set(turnId, timestamp);
      if (event.type === "assistant/message") {
        const usage = readUsage(payload.usage ?? payload);
        inputTokens = addOptional(inputTokens, usage.inputTokens);
        outputTokens = addOptional(outputTokens, usage.outputTokens);
        cacheReadTokens = addOptional(cacheReadTokens, usage.cacheReadTokens);
        reasoningTokens = addOptional(reasoningTokens, usage.reasoningTokens);
        if (turnId !== undefined && timestamp !== undefined) {
          const pending = [...stepStarts.entries()].find(([key]) => key.startsWith(`${turnId}:`));
          if (pending !== undefined) {
            const [key, starts] = pending;
            const started = starts[0];
            if (started !== undefined && timestamp >= started) llmDurations.push(timestamp - started);
            stepStarts.delete(key);
          }
        }
      }
    } else if (event.type === "tool/call") {
      const toolCallId = String(payload.toolCallId ?? payload.id ?? `${event.sequence}`);
      if (timestamp !== undefined) toolStarts.set(toolCallId, timestamp);
    } else if (event.type === "tool/result") {
      const toolCallId = String(payload.toolCallId ?? payload.id ?? "");
      const started = toolStarts.get(toolCallId);
      if (started !== undefined && timestamp !== undefined && timestamp >= started) toolDurations.push(timestamp - started);
      toolStarts.delete(toolCallId);
    }
  }

  const stepCount = ordered.filter((event) => event.type === "step/started").length;
  const toolCallCount = ordered.filter((event) => event.type === "tool/call").length;
  const turnDurationMs = sum(turnDurations);
  const llmDurationMs = sum(llmDurations);
  const toolDurationMs = sum(toolDurations);
  const ttftMs = reportedTtft ?? firstAssistantDelta(firstTurnStart, firstAssistant);
  const totalTokens = inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens;
  const outputTokensPerSecond = outputTokens === undefined || llmDurationMs === undefined || llmDurationMs <= 0 ? undefined : outputTokens / (llmDurationMs / 1000);
  const cacheHitPercent = inputTokens === undefined || inputTokens <= 0 || cacheReadTokens === undefined ? undefined : Math.min(100, cacheReadTokens / inputTokens * 100);
  return {
    turnCount: turns.size,
    stepCount,
    toolCallCount,
    ...(turnDurationMs === undefined ? {} : { turnDurationMs }),
    ...(llmDurationMs === undefined ? {} : { llmDurationMs }),
    ...(toolDurationMs === undefined ? {} : { toolDurationMs }),
    ...(ttftMs === undefined ? {} : { ttftMs }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }),
    ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
    ...(status === undefined ? {} : { status }),
  };
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${formatDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatDecimal(value / 1_000)}k`;
  return String(Math.round(value));
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${formatDecimal(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function eventTime(event: UsageEvent): number | undefined {
  const value = Date.parse(event.createdAt);
  return Number.isFinite(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readUsage(value: unknown): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number } {
  if (typeof value !== "object" || value === null) return {};
  const source = value as Record<string, unknown>;
  const inputTokens = finiteNumber(source.inputTokens ?? source.input_tokens ?? source.promptTokens ?? source.prompt_tokens);
  const outputTokens = finiteNumber(source.outputTokens ?? source.output_tokens ?? source.completionTokens ?? source.completion_tokens);
  const cacheReadTokens = finiteNumber(source.cacheReadTokens ?? source.cache_read_tokens ?? source.cachedTokens ?? source.cached_tokens ?? source.promptCacheHitTokens ?? source.prompt_cache_hit_tokens);
  const reasoningTokens = finiteNumber(source.reasoningTokens ?? source.reasoning_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function addOptional(previous: number | undefined, next: number | undefined): number | undefined {
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  return previous + next;
}

function sum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
}

function firstAssistantDelta(starts: ReadonlyMap<string, number>, assistants: ReadonlyMap<string, number>): number | undefined {
  const deltas = [...assistants.entries()].map(([turnId, timestamp]) => {
    const started = starts.get(turnId);
    return started === undefined || timestamp < started ? undefined : timestamp - started;
  }).filter((value): value is number => value !== undefined);
  return deltas.length === 0 ? undefined : Math.min(...deltas);
}

function formatDecimal(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/u, "");
}

function shouldUseExplicitTtft(previous: number | undefined, next: number | undefined): boolean {
  return previous === undefined && next !== undefined;
}
