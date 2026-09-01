import type { ContextProjectMemoryProjection, ContextSessionMemoryProjection, MemoryCapability, SessionProjection } from "@coding-agent/contracts";

export interface MemoryInspectorRenderIntent {
  readonly status: "available" | "unavailable" | "disabled" | "incomplete";
  readonly label: string;
  readonly detail: string;
  readonly session?: ContextSessionMemoryProjection;
  readonly project?: ContextProjectMemoryProjection;
}

/** Read-only inspector for bounded Memory readiness and projection metadata. */
export function presentMemoryInspector(session: SessionProjection | undefined, capability?: MemoryCapability): MemoryInspectorRenderIntent {
  if (capability === undefined) return { status: "unavailable", label: "记忆 · 不可用", detail: "主机未提供 Memory 能力元数据。" };
  const project = session?.contextProjectMemory;
  const incomplete = project?.status === "incomplete" || project?.scanStatus === "incomplete";
  const disabled = capability.session.status === "disabled" && capability.project.status === "disabled";
  const unavailable = capability.session.status === "unavailable" && capability.project.status === "unavailable";
  const status = incomplete ? "incomplete" : disabled ? "disabled" : unavailable ? "unavailable" : "available";
  const sessionDetail = capability.session.status === "available"
    ? session?.contextSessionMemory === undefined ? "Session Memory 已配置，尚无抽取投影。" : `Session Memory：${session.contextSessionMemory.status}，已抽取 ${session.contextSessionMemory.lastExtractedTokens} tokens。`
    : `Session Memory：${capability.session.reason ?? capability.session.status}。`;
  const projectDetail = capability.project.status === "available"
    ? project === undefined ? "Project Memory 已配置，尚无召回投影。" : `Project Memory：${project.status}，${project.topicCount} 个 topic，召回 ${project.recalledTopicIds?.length ?? 0} 个${project.usingLastGood ? "（使用 last-good 索引）" : ""}。`
    : `Project Memory：${capability.project.reason ?? capability.project.status}。`;
  return {
    status,
    label: `记忆 · ${status === "available" ? "可用" : status === "incomplete" ? "扫描不完整" : status === "disabled" ? "已禁用" : "不可用"}`,
    detail: `${sessionDetail} ${projectDetail}`,
    ...(session?.contextSessionMemory === undefined ? {} : { session: session.contextSessionMemory }),
    ...(project === undefined ? {} : { project }),
  };
}
