import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentKind, AttachmentReceipt, SessionProjection } from "@coding-agent/contracts";
import { WorkspaceResolver, WorkspaceViolation } from "@coding-agent/workspace";

export interface AttachmentPolicy {
  readonly enabled?: boolean;
  readonly maxBytes?: number;
  readonly allowedMediaTypes?: readonly string[];
  readonly imagesEnabled?: boolean;
}

export interface AttachmentCapability {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly allowedMediaTypes: readonly string[];
  readonly imagesEnabled: boolean;
  readonly reason?: string;
}

export interface AttachmentUploadInput {
  readonly fileName: string;
  readonly mediaType: string;
  /** Standard base64 only. Bytes are never retained in the event log. */
  readonly data: string;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MEDIA_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"] as const;

export function attachmentCapability(policy: AttachmentPolicy = {}, modelSupportsImages = false): AttachmentCapability {
  const maxBytes = Number.isFinite(policy.maxBytes) ? Math.min(768 * 1024, Math.max(1, Math.floor(policy.maxBytes!))) : DEFAULT_MAX_BYTES;
  const allowedMediaTypes = [...new Set((policy.allowedMediaTypes ?? DEFAULT_MEDIA_TYPES).map(normalizeMediaType).filter(Boolean))];
  const enabled = policy.enabled !== false;
  return {
    enabled,
    maxBytes,
    allowedMediaTypes,
    imagesEnabled: policy.imagesEnabled ?? modelSupportsImages,
    ...(enabled ? {} : { reason: "Attachments are disabled by the host policy." }),
  };
}

/** Stages one host-validated upload in the owning Session workspace. */
export async function stageAttachment(session: SessionProjection, input: AttachmentUploadInput, capability: AttachmentCapability, commandId: string): Promise<AttachmentReceipt> {
  const createdAt = new Date().toISOString();
  const fileName = normalizeFileName(input.fileName);
  const mediaType = normalizeMediaType(input.mediaType);
  const attachmentId = `att_${createHash("sha256").update(commandId).digest("hex").slice(0, 24)}`;
  const kind: AttachmentKind = mediaType.startsWith("image/") ? "image" : "file";
  const reject = (code: string, reason: string, sizeBytes = 0): AttachmentReceipt => ({ id: attachmentId, status: "rejected", fileName, mediaType, sizeBytes, kind, createdAt, code, reason });

  if (!capability.enabled) return reject("ATTACHMENT_DISABLED", capability.reason ?? "Attachments are disabled by the host policy.");
  if (!capability.allowedMediaTypes.includes(mediaType)) return reject("ATTACHMENT_MEDIA_TYPE_DENIED", `Media type is not allowed: ${mediaType}`);
  if (kind === "image" && !capability.imagesEnabled) return reject("ATTACHMENT_IMAGE_UNAVAILABLE", "Image attachments require an image-capable host configuration.");

  let bytes: Buffer;
  try {
    bytes = decodeBase64(input.data);
  } catch {
    return reject("ATTACHMENT_DATA_INVALID", "Attachment data must be standard base64.");
  }
  if (bytes.byteLength > capability.maxBytes) return reject("ATTACHMENT_TOO_LARGE", `Attachment exceeds the ${formatByteLimit(capability.maxBytes)} limit.`, bytes.byteLength);

  const relativePath = `.agent-artifacts/attachments/${attachmentId}-${safeFileName(fileName)}`;
  const resolver = new WorkspaceResolver(session.workspaceRoot);
  try {
    await mkdir(path.dirname(resolver.resolve(relativePath)), { recursive: true });
    const target = await resolver.resolveForWrite(relativePath);
    try {
      await writeFile(target, bytes, { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existingInfo = await lstat(target);
      if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) return reject("ATTACHMENT_STORAGE_CONFLICT", "Attachment target is not a regular file.", bytes.byteLength);
      const existing = await readFile(target);
      if (!existing.equals(bytes)) return reject("ATTACHMENT_RECEIPT_CONFLICT", "An attachment command was replayed with different bytes.", bytes.byteLength);
    }
  } catch (error) {
    if (error instanceof WorkspaceViolation) return reject("ATTACHMENT_WORKSPACE_DENIED", "Attachment storage path is outside the current workspace.", bytes.byteLength);
    return reject("ATTACHMENT_STORAGE_FAILED", "Unable to persist the attachment in the current workspace.", bytes.byteLength);
  }
  return { id: attachmentId, status: "accepted", fileName, mediaType, sizeBytes: bytes.byteLength, kind, createdAt, relativePath };
}

function normalizeFileName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 180 || path.basename(trimmed) !== trimmed || trimmed === "." || trimmed === "..") throw new AttachmentInputError("fileName must be a simple file name up to 180 characters");
  return trimmed;
}

function safeFileName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return sanitized.length === 0 ? "attachment" : sanitized;
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function decodeBase64(value: string): Buffer {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) throw new Error("invalid base64");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64") !== normalized) throw new Error("invalid base64");
  return bytes;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function formatByteLimit(value: number): string {
  return value >= 1024 ? `${Math.floor(value / 1024)} KiB` : `${value} bytes`;
}

export class AttachmentInputError extends Error {}
