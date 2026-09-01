import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectMemoryEntrypoint,
  ProjectMemoryScope,
  ProjectMemoryStore,
  ProjectMemoryTopic,
  ProjectMemoryTopicHeader,
  ProjectMemoryTopicInput,
  ProjectMemoryType,
} from "./project-memory.js";

export const PROJECT_MEMORY_FILE_VERSION = 1 as const;
export const DEFAULT_PROJECT_MEMORY_MAX_TOPIC_BYTES = 64_000;
export const DEFAULT_PROJECT_MEMORY_MAX_TOPICS = 256;

export interface ProjectMemoryFileStoreOptions {
  readonly rootDir: string;
  readonly maxEntrypointBytes?: number;
  readonly maxTopicBytes?: number;
  readonly maxTopics?: number;
  readonly writerPolicy?: ProjectMemoryWriterPolicy;
}

/** Explicit policy gate for model/host writes. */
export interface ProjectMemoryWriterPolicyOptions {
  readonly maxContentBytes?: number;
  readonly allowedTypes?: readonly ProjectMemoryType[];
  readonly allowEntrypoint?: boolean;
}

export class ProjectMemoryWriterPolicy {
  readonly maxContentBytes: number;
  readonly allowedTypes: ReadonlySet<ProjectMemoryType>;
  readonly allowEntrypoint: boolean;
  constructor(options: ProjectMemoryWriterPolicyOptions = {}) {
    this.maxContentBytes = positive(options.maxContentBytes, DEFAULT_PROJECT_MEMORY_MAX_TOPIC_BYTES);
    this.allowedTypes = new Set(options.allowedTypes ?? ["user", "feedback", "project", "reference"]);
    this.allowEntrypoint = options.allowEntrypoint ?? true;
  }
  validateEntrypoint(content: string): void {
    if (!this.allowEntrypoint) throw new Error("PROJECT_MEMORY_ENTRYPOINT_WRITE_DISABLED");
    if (typeof content !== "string" || content.trim().length === 0) throw new Error("PROJECT_MEMORY_CONTENT_EMPTY");
    if (Buffer.byteLength(content, "utf8") > this.maxContentBytes) throw new Error("PROJECT_MEMORY_CONTENT_TOO_LARGE");
  }
  validateTopic(input: ProjectMemoryTopicInput): void {
    if (typeof input.title !== "string" || input.title.trim() === "" || input.title.length > 200) throw new Error("PROJECT_MEMORY_TITLE_INVALID");
    if (typeof input.content !== "string" || input.content.trim() === "") throw new Error("PROJECT_MEMORY_CONTENT_EMPTY");
    if (Buffer.byteLength(input.content, "utf8") > this.maxContentBytes) throw new Error("PROJECT_MEMORY_CONTENT_TOO_LARGE");
    if (input.type !== undefined && !this.allowedTypes.has(input.type)) throw new Error("PROJECT_MEMORY_TYPE_NOT_ALLOWED");
    if (input.id !== undefined) normalizeTopicId(input.id);
    if (input.references !== undefined) {
      if (input.references.length > 32) throw new Error("PROJECT_MEMORY_REFERENCES_TOO_MANY");
      for (const reference of input.references) {
        if (reference.kind !== "path" && reference.kind !== "symbol" && reference.kind !== "flag") throw new Error("PROJECT_MEMORY_REFERENCE_INVALID");
        if (typeof reference.value !== "string" || reference.value.length === 0 || reference.value.length > 512 || /[\r\n]/u.test(reference.value)) throw new Error("PROJECT_MEMORY_REFERENCE_INVALID");
        if (reference.kind === "path" && (reference.value.startsWith("/") || reference.value.includes("\\") || reference.value.split("/").some((part) => part === ".." || part === ""))) throw new Error("PROJECT_MEMORY_REFERENCE_PATH_INVALID");
      }
    }
  }
}

/** Filesystem Project Memory adapter. All reads fail closed on malformed or unsafe files. */
export class FileProjectMemoryStore implements ProjectMemoryStore {
  readonly rootDir: string;
  readonly maxEntrypointBytes: number;
  readonly maxTopicBytes: number;
  readonly maxTopics: number;
  readonly writerPolicy: ProjectMemoryWriterPolicy;
  private readonly tails = new Map<string, Promise<void>>();
  constructor(options: ProjectMemoryFileStoreOptions) {
    if (!options.rootDir?.trim()) throw new Error("PROJECT_MEMORY_ROOT_REQUIRED");
    this.rootDir = path.resolve(options.rootDir);
    this.maxEntrypointBytes = positive(options.maxEntrypointBytes, 25_000);
    this.maxTopicBytes = positive(options.maxTopicBytes, DEFAULT_PROJECT_MEMORY_MAX_TOPIC_BYTES);
    this.maxTopics = positive(options.maxTopics, DEFAULT_PROJECT_MEMORY_MAX_TOPICS);
    this.writerPolicy = options.writerPolicy ?? new ProjectMemoryWriterPolicy({ maxContentBytes: this.maxTopicBytes });
  }
  async getEntrypoint(scope: ProjectMemoryScope): Promise<ProjectMemoryEntrypoint | undefined> {
    const file = await this.safePath(scope, "MEMORY.md", false);
    return this.readBounded(file, this.maxEntrypointBytes, "PROJECT_MEMORY_ENTRYPOINT");
  }
  async listTopics(scope: ProjectMemoryScope): Promise<readonly ProjectMemoryTopicHeader[]> {
    const dir = await this.scopeTopicsDir(scope, false);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw storageError("PROJECT_MEMORY_SCAN_FAILED", error); }
    const result: ProjectMemoryTopicHeader[] = [];
    for (const entry of entries) {
      if (result.length >= this.maxTopics) break;
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const topic = await this.readTopic(scope, entry.name.slice(0, -3));
        if (topic !== undefined) result.push(topic);
      } catch { /* malformed/incomplete topic is ignored (last-good scan) */ }
    }
    return result;
  }
  async readTopic(scope: ProjectMemoryScope, topicId: string): Promise<ProjectMemoryTopic | undefined> {
    const id = normalizeTopicId(topicId);
    const file = await this.safePath(scope, path.posix.join("topics", `${id}.md`), false);
    const parsed = await this.readBounded(file, this.maxTopicBytes, "PROJECT_MEMORY_TOPIC");
    if (parsed === undefined) return undefined;
    const meta = parseFrontmatter(parsed.content);
    if (meta.name === undefined || meta.version !== String(PROJECT_MEMORY_FILE_VERSION) || (meta.type !== undefined && !isType(meta.type))) throw new Error("PROJECT_MEMORY_TOPIC_CORRUPT");
    const references = parseReferences(meta.references);
    return { id, path: `topics/${id}.md`, title: meta.name, ...(meta.description === undefined ? {} : { description: meta.description }), ...(meta.type === undefined ? {} : { type: meta.type }), ...(meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }), ...(parsed.mtimeMs === undefined ? {} : { mtimeMs: parsed.mtimeMs }), ...(references === undefined ? {} : { references }), content: meta.body };
  }
  async writeEntrypoint(scope: ProjectMemoryScope, content: string): Promise<void> {
    this.writerPolicy.validateEntrypoint(content);
    if (Buffer.byteLength(content, "utf8") > this.maxEntrypointBytes) throw new Error("PROJECT_MEMORY_ENTRYPOINT_TOO_LARGE");
    await this.withScopeLock(scope, async () => { const target = await this.safePath(scope, "MEMORY.md", true); await atomicWrite(target, content.endsWith("\n") ? content : `${content}\n`); });
  }
  async writeTopic(scope: ProjectMemoryScope, input: ProjectMemoryTopicInput): Promise<ProjectMemoryTopic> {
    this.writerPolicy.validateTopic(input);
    const id = normalizeTopicId(input.id ?? slug(input.title));
    const updatedAt = new Date().toISOString();
    await this.withScopeLock(scope, async () => {
      const target = await this.safePath(scope, path.posix.join("topics", `${id}.md`), true);
      const body = formatTopic({ ...input, id, updatedAt });
      if (Buffer.byteLength(body, "utf8") > this.maxTopicBytes) throw new Error("PROJECT_MEMORY_TOPIC_TOO_LARGE");
      await atomicWrite(target, body);
    });
    const topic = await this.readTopic(scope, id);
    if (topic === undefined) throw new Error("PROJECT_MEMORY_WRITE_NOT_VISIBLE");
    return topic;
  }
  private async withScopeLock<T>(scope: ProjectMemoryScope, operation: () => Promise<T>): Promise<T> {
    const key = scope.scopeKey;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current); this.tails.set(key, tail); await previous;
    try { return await operation(); } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
  private async scopeTopicsDir(scope: ProjectMemoryScope, create: boolean): Promise<string> {
    const dir = await this.scopeDir(scope, create); const topics = path.join(dir, "topics");
    if (create) await mkdir(topics, { recursive: true, mode: 0o700 });
    return topics;
  }
  private async scopeDir(scope: ProjectMemoryScope, create: boolean): Promise<string> {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(scope.scopeKey)) throw new Error("PROJECT_MEMORY_SCOPE_INVALID");
    await ensureDir(this.rootDir, create, "PROJECT_MEMORY_ROOT");
    const dir = path.join(this.rootDir, scope.scopeKey);
    await ensureDir(dir, create, "PROJECT_MEMORY_SCOPE");
    return dir;
  }
  private async safePath(scope: ProjectMemoryScope, relative: string, create: boolean): Promise<string> {
    const dir = relative.startsWith("topics/") ? await this.scopeTopicsDir(scope, create) : await this.scopeDir(scope, create);
    const target = path.resolve(dir, relative.startsWith("topics/") ? relative.slice("topics/".length) : relative);
    const rel = path.relative(dir, target); if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("PROJECT_MEMORY_PATH_ESCAPE");
    try { const info = await lstat(target); if (info.isSymbolicLink()) throw new Error("PROJECT_MEMORY_SYMLINK_DENIED"); if (!info.isFile() && !info.isDirectory()) throw new Error("PROJECT_MEMORY_TARGET_INVALID"); } catch (error) { if (!isMissing(error)) throw error; }
    return target;
  }
  private async readBounded(file: string, maxBytes: number, label: string): Promise<ParsedFile | undefined> {
    let info; try { info = await lstat(file); } catch (error) { if (isMissing(error)) return undefined; throw storageError(`${label}_READ_FAILED`, error); }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label}_TARGET_INVALID`);
    if (info.size > maxBytes) throw new Error(`${label}_TOO_LARGE`);
    const content = await readFile(file, "utf8"); if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error(`${label}_TOO_LARGE`);
    return { content, mtimeMs: info.mtimeMs };
  }
}

function formatTopic(input: ProjectMemoryTopicInput & { readonly id: string; readonly updatedAt: string }): string {
  const references = input.references === undefined ? undefined : JSON.stringify(input.references);
  return ["---", `version: ${PROJECT_MEMORY_FILE_VERSION}`, `name: ${JSON.stringify(input.title.trim())}`, ...(input.description === undefined ? [] : [`description: ${JSON.stringify(input.description.trim())}`]), `type: ${input.type ?? "project"}`, ...(references === undefined ? [] : [`references: ${references}`]), `updatedAt: ${JSON.stringify(input.updatedAt)}`, "---", input.content.trim(), ""].join("\n");
}
function parseFrontmatter(raw: string): { body: string; version?: string; name?: string; description?: string; type?: string; references?: string; updatedAt?: string } {
  if (!raw.startsWith("---\n")) throw new Error("PROJECT_MEMORY_TOPIC_CORRUPT"); const end = raw.indexOf("\n---\n", 4); if (end < 0) throw new Error("PROJECT_MEMORY_TOPIC_CORRUPT");
  const meta: Record<string, string> = {}; for (const line of raw.slice(4, end).split("\n")) { const i = line.indexOf(":"); if (i <= 0) throw new Error("PROJECT_MEMORY_TOPIC_CORRUPT"); const key = line.slice(0, i).trim(); let val = line.slice(i + 1).trim(); try { if (val.startsWith('"')) val = JSON.parse(val) as string; } catch { throw new Error("PROJECT_MEMORY_TOPIC_CORRUPT"); } meta[key] = val; }
  return { ...(meta["version"] === undefined ? {} : { version: meta["version"] }), ...(meta["name"] === undefined ? {} : { name: meta["name"] }), ...(meta["description"] === undefined ? {} : { description: meta["description"] }), ...(meta["type"] === undefined ? {} : { type: meta["type"] }), ...(meta["references"] === undefined ? {} : { references: meta["references"] }), ...(meta["updatedAt"] === undefined ? {} : { updatedAt: meta["updatedAt"] }), body: raw.slice(end + 5).trim() };
}
interface ParsedFile { readonly content: string; readonly mtimeMs?: number }
function normalizeTopicId(value: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value)) throw new Error("PROJECT_MEMORY_TOPIC_ID_INVALID"); return value; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || `topic-${randomUUID().slice(0, 8)}`; }
function isType(value: string): value is ProjectMemoryType { return value === "user" || value === "feedback" || value === "project" || value === "reference"; }
function parseReferences(value: string | undefined): readonly { readonly kind: "path" | "symbol" | "flag"; readonly value: string }[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 32) throw new Error("bad");
    return parsed.map((item) => {
      if (typeof item !== "object" || item === null) throw new Error("bad");
      const rec = item as Record<string, unknown>;
      if ((rec["kind"] !== "path" && rec["kind"] !== "symbol" && rec["kind"] !== "flag") || typeof rec["value"] !== "string" || rec["value"].length > 512) throw new Error("bad");
      return { kind: rec["kind"], value: rec["value"] } as { readonly kind: "path" | "symbol" | "flag"; readonly value: string };
    });
  } catch { throw new Error("PROJECT_MEMORY_TOPIC_CORRUPT"); }
}
function positive(value: number | undefined, fallback: number): number { return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
async function ensureDir(dir: string, create: boolean, label: string): Promise<void> { try { const info = await lstat(dir); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}_INVALID`); } catch (error) { if (!isMissing(error) || !create) { if (isMissing(error) && !create) return; throw error; } await mkdir(dir, { recursive: true, mode: 0o700 }); const info = await lstat(dir); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}_INVALID`); } }
async function atomicWrite(target: string, content: string): Promise<void> { const temp = `${target}.tmp-${randomUUID()}`; try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); } try { await rename(temp, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await rm(target, { force: true }); await rename(temp, target); } } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw storageError("PROJECT_MEMORY_WRITE_FAILED", error); } }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function storageError(code: string, error: unknown): Error { return Object.assign(new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`), { code }); }
