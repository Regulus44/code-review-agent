import path from "node:path";
import { stat } from "node:fs/promises";
import type { ArtifactRef, SessionProjection, TaskId } from "@coding-agent/contracts";
import { WorkspaceResolver, WorkspaceViolation } from "@coding-agent/workspace";

export const MAX_ARTIFACT_CONTENT_BYTES = 8 * 1024 * 1024;

export type ArtifactAvailability = "available" | "external" | "blocked" | "missing" | "not_file" | "too_large" | "unavailable";

export interface ArtifactAccessBase {
  readonly artifact: ArtifactRef;
  readonly taskId?: TaskId;
  readonly availability: ArtifactAvailability;
  readonly reason: string;
}

export interface AvailableArtifactAccess extends ArtifactAccessBase {
  readonly availability: "available";
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly fileName: string;
}

export interface UnavailableArtifactAccess extends ArtifactAccessBase {
  readonly availability: Exclude<ArtifactAvailability, "available">;
}

export type ArtifactAccess = AvailableArtifactAccess | UnavailableArtifactAccess;

export interface ArtifactAccessResponse {
  readonly taskId?: TaskId;
  readonly artifact: ArtifactRef;
  readonly availability: ArtifactAvailability;
  readonly reason: string;
  readonly sizeBytes?: number;
  readonly contentType?: string;
}

export class ArtifactLookupError extends Error {
  readonly code = "ARTIFACT_AMBIGUOUS";
}

/**
 * Resolve an event-derived artifact through the current Session workspace.
 * The stored path is never sufficient authority: every content request repeats
 * lexical, existence and symlink-aware checks with WorkspaceResolver.
 */
export async function inspectArtifact(session: SessionProjection, artifactId: string): Promise<ArtifactAccess | undefined> {
  const lookup = findArtifact(session, artifactId);
  if (lookup === undefined) return undefined;
  const { artifact, taskId } = lookup;

  if (artifact.kind === "url" || isHttpUrl(artifact.path)) {
    return unavailable(artifact, taskId, "external", "External artifacts require an explicit host policy.");
  }
  if (artifact.path === undefined || artifact.path.trim().length === 0) {
    return unavailable(artifact, taskId, "unavailable", "Artifact has no readable workspace path.");
  }

  const resolver = new WorkspaceResolver(session.workspaceRoot);
  try {
    resolver.resolve(artifact.path);
  } catch (error) {
    if (error instanceof WorkspaceViolation) return unavailable(artifact, taskId, "blocked", "Path is outside the current workspace scope.");
    throw error;
  }

  try {
    // Check existence before realpath so an ordinary absent output remains a
    // useful 404 rather than being confused with a symlink boundary failure.
    await stat(resolver.resolve(artifact.path));
  } catch {
    return unavailable(artifact, taskId, "missing", "Artifact file is no longer present in the workspace.");
  }

  let filePath: string;
  try {
    filePath = await resolver.resolveExisting(artifact.path);
  } catch (error) {
    if (error instanceof WorkspaceViolation) return unavailable(artifact, taskId, "blocked", "Artifact path resolves outside the current workspace scope.");
    throw error;
  }

  const info = await stat(filePath);
  if (!info.isFile()) return unavailable(artifact, taskId, "not_file", "Artifact path is not a regular file.");
  if (info.size > MAX_ARTIFACT_CONTENT_BYTES) {
    return unavailable(artifact, taskId, "too_large", `Artifact exceeds the ${formatByteLimit(MAX_ARTIFACT_CONTENT_BYTES)} content limit.`);
  }
  return {
    artifact,
    ...(taskId === undefined ? {} : { taskId }),
    availability: "available",
    reason: "Workspace path is validated by the host for inline view or download.",
    filePath,
    sizeBytes: info.size,
    contentType: safeContentType(artifact.mediaType, filePath),
    fileName: safeFileName(path.basename(filePath) || artifact.label),
  };
}

export function artifactAccessResponse(access: ArtifactAccess): ArtifactAccessResponse {
  return {
    ...(access.taskId === undefined ? {} : { taskId: access.taskId }),
    artifact: access.artifact,
    availability: access.availability,
    reason: access.reason,
    ...(access.availability === "available" ? { sizeBytes: access.sizeBytes, contentType: access.contentType } : {}),
  };
}

export function isAvailableArtifact(access: ArtifactAccess): access is AvailableArtifactAccess {
  return access.availability === "available";
}

function findArtifact(session: SessionProjection, artifactId: string): { readonly artifact: ArtifactRef; readonly taskId?: TaskId } | undefined {
  const taskMatches = session.tasks.flatMap((task) => task.artifacts
    .filter((artifact) => artifact.id === artifactId)
    .map((artifact) => ({ artifact, taskId: task.id })));
  const replacementMatches = (session.toolResultReplacements ?? [])
    .filter((replacement) => replacement.artifact.id === artifactId || replacement.toolCallId === artifactId)
    .map((replacement) => ({ artifact: replacement.artifact }));
  const matches = [...taskMatches, ...replacementMatches];
  if (matches.length <= 1) return matches[0];
  throw new ArtifactLookupError(`Artifact id is ambiguous in session: ${artifactId}`);
}

function unavailable(artifact: ArtifactRef, taskId: TaskId | undefined, availability: UnavailableArtifactAccess["availability"], reason: string): UnavailableArtifactAccess {
  return { artifact, ...(taskId === undefined ? {} : { taskId }), availability, reason };
}

function isHttpUrl(value: string | undefined): boolean {
  return typeof value === "string" && /^https?:\/\//iu.test(value);
}

function safeContentType(declared: string | undefined, filePath: string): string {
  const normalized = declared?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "application/json" || normalized === "text/plain" || normalized === "text/markdown" || normalized === "text/x-diff" || normalized === "application/xml") return normalized;
  switch (path.extname(filePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".txt":
    case ".log":
    case ".md":
    case ".diff":
    case ".patch": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function safeFileName(value: string): string {
  const normalized = value.replace(/[\r\n"\\/]/gu, "_").trim().slice(0, 160);
  return normalized.length === 0 ? "artifact" : normalized;
}

function formatByteLimit(value: number): string {
  return `${Math.floor(value / (1024 * 1024))} MiB`;
}
