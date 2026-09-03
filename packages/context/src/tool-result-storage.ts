import type { ArtifactRef, ToolResultReplacementRecord, ToolResultReplacementReason } from "@coding-agent/contracts";
import { createHash } from "node:crypto";

/**
 * Host-owned immutable snapshot for a Skill resource. Implementations must
 * keep the bytes outside the user workspace and enforce session/tenant ACLs
 * on reads. The EventStore stores only the receipt returned by this adapter.
 */
export interface SkillResourceArtifactStore {
  write(input: {
    readonly artifactId: string;
    readonly sessionId: string;
    readonly tenantId?: string;
    readonly skill: string;
    readonly path: string;
    readonly content: string;
    readonly mediaType?: string;
    readonly digest: string;
  }): Promise<"created" | "exists">;
  read(input: {
    readonly artifactId: string;
    readonly sessionId: string;
    readonly tenantId?: string;
  }): Promise<{ readonly content: string; readonly digest: string } | undefined>;
}

/** Small host-owned implementation useful for local hosts and replay tests. */
export class InMemorySkillResourceArtifactStore implements SkillResourceArtifactStore {
  private readonly records = new Map<string, { readonly sessionId: string; readonly tenantId?: string; readonly content: string; readonly digest: string }>();

  async write(input: Parameters<SkillResourceArtifactStore["write"]>[0]): Promise<"created" | "exists"> {
    const previous = this.records.get(input.artifactId);
    if (previous !== undefined) {
      if (previous.digest !== input.digest || previous.sessionId !== input.sessionId || previous.tenantId !== input.tenantId) throw new Error("SKILL_RESOURCE_ARTIFACT_CONFLICT");
      return "exists";
    }
    this.records.set(input.artifactId, { sessionId: input.sessionId, ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }), content: input.content, digest: input.digest });
    return "created";
  }

  async read(input: Parameters<SkillResourceArtifactStore["read"]>[0]): Promise<{ readonly content: string; readonly digest: string } | undefined> {
    const record = this.records.get(input.artifactId);
    if (record === undefined || record.sessionId !== input.sessionId || record.tenantId !== input.tenantId) return undefined;
    return { content: record.content, digest: record.digest };
  }
}

export interface SkillResourceArtifactReceipt {
  readonly kind: "skill-resource";
  readonly artifactId: string;
  readonly skill: string;
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly truncated?: boolean;
  readonly mediaType?: string;
  readonly provider?: string;
}

export function skillResourceArtifactId(sessionId: string, skill: string, resourcePath: string, digest: string, offset?: number, limit?: number): string {
  const key = [sessionId, skill, resourcePath, digest, offset ?? "", limit ?? ""].join("\u0000");
  return `artifact_skill_resource_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export function buildSkillResourceModelView(receipt: SkillResourceArtifactReceipt, content?: string): string {
  const status = content === undefined ? "unavailable" : "available";
  const attributes = [
    `skill=${JSON.stringify(receipt.skill)}`,
    `path=${JSON.stringify(receipt.path)}`,
    `status=${JSON.stringify(status)}`,
    `digest=${JSON.stringify(receipt.digest)}`,
    ...(receipt.offset === undefined ? [] : [`offset=${receipt.offset}`]),
    ...(receipt.limit === undefined ? [] : [`limit=${receipt.limit}`]),
  ].join(" ");
  const recovery = content === undefined
    ? "Resource snapshot is unavailable; do not reread the current workspace file as historical content."
    : receipt.truncated === true ? "(Output capped. Use offset=... to continue.)" : "";
  return `<skill_resource ${attributes}>\n${content ?? recovery}\n</skill_resource>`;
}

export const DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS = 50_000;
export const DEFAULT_TOOL_RESULT_MAX_TOKENS = 100_000;
export const DEFAULT_TOOL_RESULT_PREVIEW_BYTES = 2_000;
export const TOOL_RESULT_ARTIFACTS_ROOT = ".agent-artifacts/tool-results";

export interface ToolResultStorageWriter {
  /** Writes one workspace-relative artifact without replacing an existing file. */
  write(input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly content: string;
    readonly mediaType: string;
  }): Promise<"created" | "exists">;
}

export interface ToolResultStorageInput {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: string;
  readonly thresholdChars?: number;
  readonly maxTokens?: number;
  readonly previewBytes?: number;
  /** Forces artifact creation for message-level aggregate budgets even below the per-result threshold. */
  readonly forcePersist?: boolean;
}

export type ToolResultStorageStatus = "persisted" | "failed" | "not-needed" | "unsupported";

export interface ToolResultStorageOutcome {
  readonly status: ToolResultStorageStatus;
  readonly modelView: string;
  readonly replacement?: ToolResultReplacementRecord;
  readonly error?: string;
}

export interface ToolResultStorage {
  persist(input: ToolResultStorageInput): Promise<ToolResultStorageOutcome>;
}

export interface ToolResultStorageConfig {
  readonly thresholdChars?: number;
  readonly maxTokens?: number;
  readonly previewBytes?: number;
}

/**
 * Creates a provider-neutral Claude Code-style single-result storage adapter.
 * The writer owns filesystem/workspace policy; this package only decides when
 * to persist, how to identify the artifact and what bounded model view to use.
 */
export function createToolResultStorage(writer: ToolResultStorageWriter, config: ToolResultStorageConfig = {}): ToolResultStorage {
  const thresholdChars = positiveInteger(config.thresholdChars, DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS);
  const maxTokens = positiveInteger(config.maxTokens, DEFAULT_TOOL_RESULT_MAX_TOKENS);
  const previewBytes = positiveInteger(config.previewBytes, DEFAULT_TOOL_RESULT_PREVIEW_BYTES);
  return {
    async persist(input: ToolResultStorageInput): Promise<ToolResultStorageOutcome> {
      const content = input.content;
      const originalChars = content.length;
      const originalBytes = utf8ByteLength(content);
      const originalTokens = estimateToolResultTokens(content);
      const threshold = positiveInteger(input.thresholdChars, thresholdChars);
      const tokenLimit = positiveInteger(input.maxTokens, maxTokens);
      const previewLimit = positiveInteger(input.previewBytes, previewBytes);
      const forcePersist = input.forcePersist === true;
      if (containsNonTextContent(content)) return { status: "unsupported", modelView: content };
      const exceedsTokens = originalTokens > tokenLimit;
      const exceedsChars = originalChars > threshold;
      if (!forcePersist && !exceedsChars && !exceedsTokens) return { status: "not-needed", modelView: content };

      const preview = truncateUtf8(redactPreview(content), previewLimit);
      const extension = isJsonText(content) ? "json" : "txt";
      const relativePath = `${TOOL_RESULT_ARTIFACTS_ROOT}/${safeSegment(input.sessionId)}/${safeSegment(input.toolCallId)}.${extension}`;
      const artifact: ArtifactRef = {
        id: stableArtifactId(relativePath),
        kind: extension === "json" ? "json" : "file",
        label: `Tool result ${input.toolCallId}`,
        path: relativePath,
        mediaType: extension === "json" ? "application/json" : "text/plain; charset=utf-8",
        sizeBytes: originalBytes,
        digest: stableDigest(content),
        preview,
      };
      const reason: ToolResultReplacementReason = exceedsTokens ? "max-tokens" : "max-chars";
      const replacement: ToolResultReplacementRecord = {
        kind: "tool-result",
        toolCallId: input.toolCallId,
        ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
        artifact,
        relativePath,
        originalChars,
        originalBytes,
        originalTokens,
        thresholdChars: threshold,
        preview,
        previewBytes: utf8ByteLength(preview),
        reason,
      };
      try {
        await writer.write({
          workspaceRoot: input.workspaceRoot,
          relativePath,
          content,
          mediaType: artifact.mediaType ?? "text/plain; charset=utf-8",
        });
        return { status: "persisted", replacement, modelView: buildToolResultModelView(replacement, true) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: ToolResultReplacementRecord = { ...replacement, reason: "persistence-failed" };
        return { status: "failed", replacement: failed, modelView: buildToolResultModelView(failed, false), error: message };
      }
    },
  };
}

/** Builds the only model-visible representation of a replacement receipt. */
export function buildToolResultModelView(record: ToolResultReplacementRecord, artifactAvailable: boolean): string {
  const status = artifactAvailable && record.reason !== "persistence-failed" ? "available" : "unavailable";
  const lines = [
    `<persisted-tool-result status=${JSON.stringify(status)}>` ,
    `artifact: ${record.relativePath}`,
    `original size: ${record.originalChars} chars / ${record.originalBytes} bytes / ${record.originalTokens} tokens`,
    `persistence threshold: ${record.thresholdChars} chars`,
    status === "available" ? "The complete result is stored in the workspace artifact above." : "The complete result is unavailable; do not infer that the preview is complete.",
    `preview (first ${record.previewBytes} UTF-8 bytes):`,
    record.preview,
    "</persisted-tool-result>",
  ];
  return lines.join("\n");
}

export function estimateToolResultTokens(content: string): number {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      const media = parsed.filter((item) => typeof item === "object" && item !== null && ((item as { type?: unknown }).type === "image" || (item as { type?: unknown }).type === "document")).length;
      if (media > 0) return media * 2_000 + Math.max(1, Math.ceil(content.length / 4));
    }
  } catch {
    // Plain text uses the conservative character estimate.
  }
  return Math.max(1, Math.ceil((content.length + 16) / 4));
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (utf8ByteLength(value) <= limit) return value;
  let used = 0;
  let output = "";
  for (const character of value) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > limit) break;
    output += character;
    used += bytes;
  }
  return output;
}

export function containsNonTextContent(value: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return false; }
  return containsMediaNode(parsed, 0);
}

/** Redacts common credential-shaped fields before a preview enters the model/event receipt. */
function redactPreview(value: string): string {
  const field = "(?:api[_-]?key|x-api-key|authorization|access[_-]?token|refresh[_-]?token|password|secret)";
  let redacted = value
    .replace(new RegExp(`([\"']?${field}[\"']?\\s*[:=]\\s*)(\")([^\"]*)(\")`, "giu"), "$1$2[REDACTED]$4")
    .replace(new RegExp(`([\"']?${field}[\"']?\\s*[:=]\\s*)(')([^']*)(')`, "giu"), "$1$2[REDACTED]$4");
  redacted = redacted.replace(new RegExp(`(${field}\\s*:\\s*)(?:bearer\\s+)?[^\\r\\n]+`, "giu"), "$1[REDACTED]");
  return redacted.replace(new RegExp(`([\"']?${field}[\"']?\\s*[:=]\\s*)([^\\s\"',}\\]]+)`, "giu"), "$1[REDACTED]");
}

function containsMediaNode(value: unknown, depth: number): boolean {
  if (depth > 16 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsMediaNode(item, depth + 1));
  const object = value as Record<string, unknown>;
  if (object.type === "image" || object.type === "document") return true;
  return Object.values(object).some((item) => containsMediaNode(item, depth + 1));
}

function isJsonText(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
  return normalized.length === 0 ? "unknown" : normalized;
}

function stableArtifactId(value: string): string {
  return `artifact_tool_result_${stableDigest(value).slice(0, 24)}`;
}

function stableDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
