import type { ArtifactRef, TaskProjection } from "@coding-agent/contracts";

export type DeliverableScope = "workspace" | "external" | "unsafe" | "unknown";

export interface DeliverableRenderIntent {
  readonly id: string;
  readonly label: string;
  readonly kind: ArtifactRef["kind"];
  readonly path?: string;
  readonly scope: DeliverableScope;
  readonly scopeLabel: string;
  readonly sourceTaskId: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly preview?: string;
  readonly action: "open" | "unavailable";
  readonly actionReason: string;
}

export interface DeliverablesRenderIntent {
  readonly items: readonly DeliverableRenderIntent[];
  readonly truncated: boolean;
}

/**
 * Convert durable task artifacts into a bounded, workspace-aware render view.
 * Workspace artifact actions point only to a host endpoint that re-checks the
 * session workspace and artifact identity; external/unsafe/pathless actions
 * remain unavailable, and the Web layer never opens a path directly.
 */
export function presentDeliverables(
  tasks: readonly TaskProjection[],
  workspaceRoot: string,
  maxItems = 64,
  maxPreviewChars = 2_000,
): DeliverablesRenderIntent {
  const byId = new Map<string, { readonly artifact: ArtifactRef; readonly taskId: string }>();
  for (const task of tasks) {
    for (const artifact of task.artifacts ?? []) {
      if (!byId.has(artifact.id)) byId.set(artifact.id, { artifact, taskId: String(task.id) });
    }
  }
  const all = [...byId.values()];
  const items = all.slice(0, Math.max(1, Math.floor(maxItems))).map(({ artifact, taskId }) => {
    const scope = artifactScope(artifact, workspaceRoot);
    const path = typeof artifact.path === "string" ? artifact.path : undefined;
    return {
      id: artifact.id,
      label: artifact.label,
      kind: artifact.kind,
      ...(path === undefined ? {} : { path }),
      scope,
      scopeLabel: scope === "workspace" ? "工作区内" : scope === "unsafe" ? "已阻止" : scope === "external" ? "外部" : "未知",
      sourceTaskId: taskId,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
      ...(artifact.preview === undefined ? {} : { preview: artifact.preview.slice(0, Math.max(1, maxPreviewChars)) }),
      action: scope === "workspace" ? "open" as const : "unavailable" as const,
      actionReason: actionReason(scope, artifact),
    };
  });
  return { items, truncated: all.length > items.length };
}

function artifactScope(artifact: ArtifactRef, workspaceRoot: string): DeliverableScope {
  const value = artifact.path;
  if (artifact.kind === "url" || (typeof value === "string" && /^https?:\/\//iu.test(value))) return "external";
  if (typeof value !== "string" || value.trim().length === 0) return "unknown";
  const root = normalize(workspaceRoot);
  const candidate = normalize(value);
  const absolute = /^\/?(?:[a-z]:\/|\/)/iu.test(candidate);
  if (absolute) return candidate === root || candidate.startsWith(`${root}/`) ? "workspace" : "unsafe";
  if (candidate.split("/").some((segment) => segment === "..")) return "unsafe";
  return "workspace";
}

function normalize(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/\/$/u, "").toLowerCase();
}

function actionReason(scope: DeliverableScope, artifact: ArtifactRef): string {
  if (scope === "workspace") return artifact.preview === undefined ? "打开或下载前，主机会校验工作区路径。" : "已有预览；打开或下载前，主机会重新校验工作区路径。";
  if (scope === "external") return "打开外部产物需要主机显式授权。";
  if (scope === "unsafe") return "路径位于当前工作区范围之外。";
  return "产物没有可读取的工作区路径。";
}
