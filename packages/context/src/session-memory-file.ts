import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SessionMemorySnapshot, SessionMemoryStore } from "./session-memory-compact.js";
import type { SessionMemoryExtractionRequest, SessionMemoryExtractionResult, SessionMemoryExtractor } from "./session-memory.js";

/** Default bounds for the host-owned local Session Memory file adapter. */
export const DEFAULT_SESSION_MEMORY_FILE_MAX_CHARS = 24_000;
export const DEFAULT_SESSION_MEMORY_FILE_MAX_BYTES = 128_000;
export const SESSION_MEMORY_FILE_VERSION = 1 as const;

export interface SessionMemoryFileStoreOptions {
  /** A host-owned directory. It must not be a workspace path supplied by a user. */
  readonly rootDir: string;
  readonly maxMemoryChars?: number;
  readonly maxMemoryBytes?: number;
}

/**
 * Bounded Markdown-backed Session Memory storage.
 *
 * Memory content intentionally lives outside EventStore. The file contains a
 * small integrity-checked frontmatter envelope so a restart can distinguish a
 * missing receipt from a half-written/corrupt snapshot. Writes use a temporary
 * file and rename, and only a strictly validated session id can select a file.
 */
export class FileSessionMemoryStore implements SessionMemoryStore {
  readonly rootDir: string;
  readonly maxMemoryChars: number;
  readonly maxMemoryBytes: number;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: SessionMemoryFileStoreOptions) {
    if (typeof options.rootDir !== "string" || options.rootDir.trim() === "") throw new Error("SESSION_MEMORY_ROOT_REQUIRED");
    this.rootDir = path.resolve(options.rootDir);
    this.maxMemoryChars = positive(options.maxMemoryChars, DEFAULT_SESSION_MEMORY_FILE_MAX_CHARS);
    this.maxMemoryBytes = positive(options.maxMemoryBytes, DEFAULT_SESSION_MEMORY_FILE_MAX_BYTES);
    if (this.maxMemoryBytes < this.maxMemoryChars) throw new Error("SESSION_MEMORY_MAX_BYTES_TOO_SMALL");
  }

  async get(sessionId: string): Promise<SessionMemorySnapshot | undefined> {
    const target = await this.safePath(sessionId, false);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw storageError("SESSION_MEMORY_READ_FAILED", error);
    }
    if (info.isSymbolicLink()) throw new Error("SESSION_MEMORY_SYMLINK_DENIED");
    if (!info.isFile()) throw new Error("SESSION_MEMORY_TARGET_NOT_FILE");
    if (info.size > this.maxMemoryBytes) throw new Error("SESSION_MEMORY_FILE_TOO_LARGE");
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      throw storageError("SESSION_MEMORY_READ_FAILED", error);
    }
    if (Buffer.byteLength(raw, "utf8") > this.maxMemoryBytes) throw new Error("SESSION_MEMORY_FILE_TOO_LARGE");
    return parseSnapshot(raw, this.maxMemoryChars);
  }

  async save(sessionId: string, snapshot: SessionMemorySnapshot): Promise<void> {
    const key = normalizeSessionId(sessionId);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      const target = await this.safePath(key, true);
      const content = normalizeContent(snapshot.content, this.maxMemoryChars);
      const lastSummarizedMessageId = optionalString(snapshot.lastSummarizedMessageId, 256);
      const existing = await this.get(key);
      const updatedAt = snapshot.updatedAt === undefined
        ? existing?.updatedAt ?? new Date().toISOString()
        : normalizeTimestamp(snapshot.updatedAt);
      const etag = digest(content, lastSummarizedMessageId, updatedAt);
      const encoded = formatSnapshot({ content, ...(lastSummarizedMessageId === undefined ? {} : { lastSummarizedMessageId }), updatedAt, etag });
      if (Buffer.byteLength(encoded, "utf8") > this.maxMemoryBytes) throw new Error("SESSION_MEMORY_FILE_TOO_LARGE");
      if (existing !== undefined && digest(existing.content, existing.lastSummarizedMessageId, existing.updatedAt ?? "") === etag) return;
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(encoded, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw storageError("SESSION_MEMORY_WRITE_FAILED", error);
      }
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async memoryPath(sessionId: string): Promise<string> {
    return this.safePath(sessionId, true);
  }

  private async safePath(sessionId: string, createRoot: boolean): Promise<string> {
    const key = normalizeSessionId(sessionId);
    await ensureSafeRoot(this.rootDir, createRoot);
    const target = path.join(this.rootDir, `${key}.md`);
    const relative = path.relative(this.rootDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("SESSION_MEMORY_PATH_ESCAPE");
    // Reject an existing symlink before a read or overwrite. Rename itself is
    // atomic and does not follow a target symlink, but refusing it makes a
    // manually planted link fail closed and keeps the writer auditable.
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("SESSION_MEMORY_SYMLINK_DENIED");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return target;
  }
}

/**
 * Safe deterministic fallback extractor used by the default local host. It
 * deliberately has no tools and only emits bounded Markdown; deployments can
 * replace it with an isolated model-backed extractor through AgentHostOptions.
 */
export function createDefaultSessionMemoryExtractor(options: { readonly maxChars?: number } = {}): SessionMemoryExtractor {
  const maxChars = positive(options.maxChars, DEFAULT_SESSION_MEMORY_FILE_MAX_CHARS);
  return {
    async extract(request: SessionMemoryExtractionRequest): Promise<SessionMemoryExtractionResult> {
      if (request.signal.aborted) throw request.signal.reason ?? new Error("Session memory extraction cancelled");
      const relevant = request.messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-12);
      const lines: string[] = ["# Session Memory", "", "## Recent context"];
      for (const message of relevant) {
        if (request.signal.aborted) throw request.signal.reason ?? new Error("Session memory extraction cancelled");
        const content = message.content.trim().replace(/[\r\n]+/gu, " ");
        if (content.length === 0) continue;
        const label = message.role === "user" ? "User" : "Assistant";
        lines.push(`- ${label}: ${content}`);
      }
      if (lines.length === 3) lines.push("- No durable context recorded yet.");
      const content = lines.join("\n").slice(0, maxChars).trim();
      const last = [...request.messages].reverse().find((message) => message.messageId !== undefined)?.messageId;
      return { snapshot: { content, ...(last === undefined ? {} : { lastSummarizedMessageId: last }) }, tokensAtExtraction: Math.max(1, Math.ceil(content.length / 4)), ...(last === undefined ? {} : { lastSummarizedMessageId: last }) };
    },
  };
}

function formatSnapshot(snapshot: SessionMemorySnapshot & { readonly etag: string }): string {
  return [
    "---",
    `version: ${SESSION_MEMORY_FILE_VERSION}`,
    `etag: ${snapshot.etag}`,
    ...(snapshot.lastSummarizedMessageId === undefined ? [] : [`lastSummarizedMessageId: ${encodeMeta(snapshot.lastSummarizedMessageId)}`]),
    `updatedAt: ${encodeMeta(snapshot.updatedAt ?? new Date().toISOString())}`,
    "---",
    snapshot.content.endsWith("\n") ? snapshot.content : `${snapshot.content}\n`,
  ].join("\n");
}

function parseSnapshot(raw: string, maxChars: number): SessionMemorySnapshot {
  if (!raw.startsWith("---\n")) throw new Error("SESSION_MEMORY_CORRUPT");
  const boundary = raw.indexOf("\n---\n", 4);
  if (boundary < 0) throw new Error("SESSION_MEMORY_CORRUPT");
  const metadata = new Map<string, string>();
  for (const line of raw.slice(4, boundary).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("SESSION_MEMORY_CORRUPT");
    metadata.set(line.slice(0, separator), decodeMeta(line.slice(separator + 1).trim()));
  }
  if (metadata.get("version") !== String(SESSION_MEMORY_FILE_VERSION)) throw new Error("SESSION_MEMORY_VERSION_UNSUPPORTED");
  const content = raw.slice(boundary + "\n---\n".length).trim();
  if (content.length === 0 || content.length > maxChars) throw new Error("SESSION_MEMORY_CORRUPT");
  const updatedAt = metadata.get("updatedAt");
  const etag = metadata.get("etag");
  if (updatedAt === undefined || etag === undefined || !/^[a-f0-9]{64}$/u.test(etag)) throw new Error("SESSION_MEMORY_CORRUPT");
  const lastSummarizedMessageId = metadata.get("lastSummarizedMessageId");
  if (lastSummarizedMessageId !== undefined) optionalString(lastSummarizedMessageId, 256);
  if (digest(content, lastSummarizedMessageId, updatedAt) !== etag) throw new Error("SESSION_MEMORY_ETAG_MISMATCH");
  return { content, ...(lastSummarizedMessageId === undefined ? {} : { lastSummarizedMessageId }), updatedAt, etag };
}

async function ensureSafeRoot(rootDir: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(rootDir);
    if (info.isSymbolicLink()) throw new Error("SESSION_MEMORY_ROOT_SYMLINK_DENIED");
    if (!info.isDirectory()) throw new Error("SESSION_MEMORY_ROOT_NOT_DIRECTORY");
  } catch (error) {
    if (!isMissing(error) || !create) {
      if (isMissing(error) && !create) return;
      throw error;
    }
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const info = await lstat(rootDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("SESSION_MEMORY_ROOT_INVALID");
  }
}

function normalizeSessionId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error("SESSION_MEMORY_SESSION_ID_INVALID");
  return value;
}

function normalizeContent(value: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("SESSION_MEMORY_CONTENT_EMPTY");
  const content = value.trim();
  if (content.length > maxChars) throw new Error("SESSION_MEMORY_CONTENT_TOO_LARGE");
  return content;
}

function optionalString(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength || /[\r\n]/u.test(value)) throw new Error("SESSION_MEMORY_METADATA_INVALID");
  return value;
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || value.length > 64 || /[\r\n]/u.test(value)) throw new Error("SESSION_MEMORY_TIMESTAMP_INVALID");
  return value;
}

function digest(content: string, lastSummarizedMessageId: string | undefined, updatedAt: string): string {
  return createHash("sha256").update(`${content}\n${lastSummarizedMessageId ?? ""}\n${updatedAt}`, "utf8").digest("hex");
}

function encodeMeta(value: string | undefined): string {
  return value === undefined ? "" : JSON.stringify(value);
}

function decodeMeta(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to a corrupt marker below
    }
  }
  if (value.length > 512 || /[\r\n]/u.test(value)) throw new Error("SESSION_MEMORY_CORRUPT");
  return value;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function storageError(code: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
