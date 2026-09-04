import { constants as fsConstants, existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl, SkillProviderObservation, SkillResourceReadOutcome, SkillResourceRequest } from "@coding-agent/contracts";
import { isSkillName } from "@coding-agent/skills";

export type SkillFilesystemRootKind = "project" | "user" | "custom" | "bundled";
export interface SkillFilesystemRoot { readonly kind: SkillFilesystemRootKind; readonly path: string; readonly rank?: number; readonly optional?: boolean; }
export interface SkillFilesystemLimits {
  readonly maxFileBytes?: number;
  readonly maxResourceBytes?: number;
  readonly maxResourcePathBytes?: number;
  /** Maximum byte offset accepted for one resource window. */
  readonly maxResourceOffsetBytes?: number;
  /** Maximum UTF-8 text lines returned by one resource window. */
  readonly maxResourceLines?: number;
  readonly maxDepth?: number;
  readonly maxSkills?: number;
  readonly maxDescriptionBytes?: number;
  /** Upper bound for directories registered with the best-effort watcher. */
  readonly maxWatchDirectories?: number;
}
export interface SkillFilesystemProviderOptions {
  readonly roots: readonly SkillFilesystemRoot[];
  /** Optional tenant owner. Tenant-owned roots are hidden from other tenants. */
  readonly tenantId?: string;
  readonly limits?: SkillFilesystemLimits;
  readonly watch?: boolean;
  readonly sourceName?: string;
  /** Disabled by default. When enabled, a symlink target must remain in the Skill directory. */
  readonly allowResourceSymlinks?: boolean;
}

const DEFAULT_LIMITS: Required<SkillFilesystemLimits> = { maxFileBytes: 256 * 1024, maxResourceBytes: 256 * 1024, maxResourcePathBytes: 4 * 1024, maxResourceOffsetBytes: 64 * 1024 * 1024, maxResourceLines: 2_000, maxDepth: 6, maxSkills: 256, maxDescriptionBytes: 2048, maxWatchDirectories: 512 };
const DEFAULT_RANK: Record<SkillFilesystemRootKind, number> = { project: 100, custom: 150, user: 200, bundled: 300 };
const FRONTMATTER_KEYS = new Set(["name", "description", "when_to_use", "whenToUse", "model_invocable", "modelInvocable", "disable-model-invocation", "user_invocable", "userInvocable", "user-invocable", "allowed-tools", "allowedTools", "context", "version", "agent", "paths"]);

type Parsed = { readonly name: string; readonly description: string; readonly whenToUse?: string; readonly modelInvocable: boolean; readonly userInvocable: boolean; readonly allowedTools?: readonly string[]; readonly paths?: readonly string[]; readonly unknown: readonly string[]; readonly body: string };
interface FileSkillLocator { readonly kind: "filesystem"; readonly skillFilePath: string; readonly skillDirectory: string; }
type Entry = { readonly candidate: SkillCandidate; readonly filePath: string; readonly skillDirectory: string; readonly root: SkillFilesystemRoot; };

/** Read-only local SKILL.md provider. Discovery is bounded; bodies are loaded only by get(). */
export class FileSystemSkillProvider implements SkillProvider {
  readonly name: string;
  readonly tenantId?: string;
  private readonly limits: Required<SkillFilesystemLimits>;
  private readonly roots: readonly SkillFilesystemRoot[];
  private readonly lastGoodByContext = new Map<string, Map<string, Entry>>();
  private readonly watchEnabled: boolean;
  private readonly allowResourceSymlinks: boolean;
  private readonly watchTargets = new Map<string, SkillFilesystemRoot>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchRoles = new Map<string, "tree" | "skill">();
  private watchSyncPromise: Promise<void> | undefined;
  private watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private watchIncomplete = false;
  private refreshPromise: Promise<SkillProviderObservation> | undefined;
  private control: SkillProviderControl | undefined;

  constructor(options: SkillFilesystemProviderOptions) {
    this.name = options.sourceName ?? "filesystem";
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.roots = options.roots.map((root) => ({ ...root, path: path.resolve(root.path) }));
    this.watchEnabled = options.watch === true;
    this.allowResourceSymlinks = options.allowResourceSymlinks === true;
    for (const root of this.roots) this.watchTargets.set(pathKey(root.path), root);
  }

  /** Explicitly rescan roots; callers may use this at turn boundaries. */
  async refresh(options: SkillLookupOptions = {}): Promise<SkillProviderObservation> { return this.scan(options, true); }

  async list(options: SkillLookupOptions = {}): Promise<SkillProviderObservation> {
    if (!this.visibleToTenant(options.tenantId)) return { candidates: [], complete: true };
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    this.refreshPromise = this.scan(options, false).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!this.visibleToTenant(options.tenantId)) return undefined;
    const entries = this.lastGoodByContext.get(this.contextKey(options));
    const entry = [...(entries?.values() ?? [])].find((item) => item.candidate.locator === candidate.locator);
    if (entry === undefined) return undefined;
    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
      const info = await lstat(entry.filePath);
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      const canonical = await realpath(entry.filePath);
      if (!samePath(canonical, entry.filePath)) return undefined;
      const text = await readFile(entry.filePath, "utf8");
      if (Buffer.byteLength(text, "utf8") > this.limits.maxFileBytes) return undefined;
      const parsed = parseSkillMarkdown(text, this.limits.maxDescriptionBytes);
      if (parsed === undefined || parsed.name !== candidate.name) return undefined;
      return { name: parsed.name, description: parsed.description, ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }), invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable }, source: entry.root.kind, provider: this.name, trust: entry.root.kind === "bundled" ? "bundled" : "local", resourceBase: { kind: "directory", path: entry.skillDirectory }, content: parsed.body, path: entry.filePath, metadata: { ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }), ...(parsed.paths === undefined ? {} : { paths: parsed.paths }), ...(parsed.unknown.length === 0 ? {} : { unknownProperties: parsed.unknown }) } };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return undefined;
    }
  }

  async readResource(candidate: SkillCandidate, request: SkillResourceRequest, options: SkillLookupOptions = {}): Promise<SkillResourceReadOutcome> {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
    if (!this.visibleToTenant(options.tenantId)) return { ok: false, error: { code: "SKILL_RESOURCE_NOT_FOUND" } };
    if (candidate.provider !== this.name) return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
    const locator = parseFileSkillLocator(candidate.locator);
    if (locator === undefined || !samePath(locator.skillFilePath, candidate.path ?? locator.skillFilePath)) return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
    const invalid = validateResourcePath(request.path, this.limits.maxResourcePathBytes);
    if (invalid) return { ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } };
    if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) return { ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } };
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) return { ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } };
    const maxBytes = this.limits.maxResourceBytes;
    if (request.limit !== undefined && request.limit > maxBytes) return { ok: false, error: { code: "SKILL_RESOURCE_TOO_LARGE" } };
    const offset = request.offset ?? 0;
    if (offset > this.limits.maxResourceOffsetBytes) return { ok: false, error: { code: "SKILL_RESOURCE_TOO_LARGE" } };
    const requestedLimit = request.limit ?? maxBytes;
    try {
      const skillDirectoryInfo = await lstat(locator.skillDirectory);
      if (!skillDirectoryInfo.isDirectory() || skillDirectoryInfo.isSymbolicLink()) return { ok: false, error: { code: "SKILL_RESOURCE_NOT_FOUND" } };
      const canonicalDirectory = await realpath(locator.skillDirectory);
      if (!samePath(canonicalDirectory, locator.skillDirectory)) return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
      const target = path.resolve(canonicalDirectory, ...request.path.replaceAll("\\", "/").split("/"));
      if (!isWithin(canonicalDirectory, target)) return { ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } };
      const info = await lstat(target);
      if (info.isSymbolicLink() && !this.allowResourceSymlinks) return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
      if (!info.isFile() && !(this.allowResourceSymlinks && info.isSymbolicLink())) return { ok: false, error: { code: info.isDirectory() ? "SKILL_RESOURCE_NOT_FOUND" : "SKILL_RESOURCE_FAILED" } };
      const canonicalTarget = await realpath(target);
      if (!isWithin(canonicalDirectory, canonicalTarget)) return { ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } };
      if (!this.allowResourceSymlinks && !samePath(canonicalTarget, target)) return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
      const canonicalInfo = await lstat(canonicalTarget);
      if (!canonicalInfo.isFile() || canonicalInfo.isSymbolicLink()) return { ok: false, error: { code: canonicalInfo.isDirectory() ? "SKILL_RESOURCE_NOT_FOUND" : "SKILL_RESOURCE_FAILED" } };
      const sizeBytes = canonicalInfo.size;
      if (sizeBytes > maxBytes && request.limit === undefined) return { ok: false, error: { code: "SKILL_RESOURCE_TOO_LARGE" } };
      const length = Math.min(requestedLimit, Math.max(0, sizeBytes - offset));
      const handle = await open(canonicalTarget, readOnlyNoFollowFlags());
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        const current = await lstat(canonicalTarget);
        const currentCanonical = await realpath(canonicalTarget);
        if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino || !samePath(currentCanonical, canonicalTarget) || !isWithin(canonicalDirectory, currentCanonical)) {
          return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
        }
        bytes = Buffer.alloc(length);
        if (length > 0) {
          const result = await handle.read(bytes, 0, length, offset);
          bytes = bytes.subarray(0, result.bytesRead);
        }
      } finally {
        await handle.close();
      }
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
      if (bytes.includes(0)) return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } };
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, error: { code: "SKILL_RESOURCE_FAILED" } }; }
      if (lineCount(content) > this.limits.maxResourceLines) return { ok: false, error: { code: "SKILL_RESOURCE_TOO_LARGE" } };
      const truncated = offset + bytes.byteLength < sizeBytes;
      return { ok: true, resource: { path: request.path, content, sizeBytes, ...(truncated ? { truncated: true } : {}), mediaType: mediaTypeForPath(request.path) } };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const code = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT" ? "SKILL_RESOURCE_NOT_FOUND" : "SKILL_RESOURCE_FAILED";
      return { ok: false, error: { code } };
    }
  }

  start(control: SkillProviderControl): void {
    this.control = control;
    if (!this.watchEnabled) return;
    control.signal.addEventListener("abort", () => this.disposeWatchers(), { once: true });
    void this.syncWatchers();
  }

  /** Explicitly close best-effort watchers; registry unregister also closes them via the control signal. */
  dispose(): void { this.disposeWatchers(); }

  private disposeWatchers(): void {
    if (this.watchDebounceTimer !== undefined) clearTimeout(this.watchDebounceTimer);
    if (this.watchRetryTimer !== undefined) clearTimeout(this.watchRetryTimer);
    this.watchDebounceTimer = undefined;
    this.watchRetryTimer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watchRoles.clear();
  }

  private async syncWatchers(): Promise<void> {
    if (!this.watchEnabled || this.control?.signal.aborted) return;
    if (this.watchSyncPromise !== undefined) return this.watchSyncPromise;
    this.watchSyncPromise = (async () => {
      const desired = new Map<string, "tree" | "skill">();
      let complete = true;
      for (const root of this.watchTargets.values()) complete = await this.collectWatchDirectories(root.path, 0, desired, root.optional === true) && complete;
      for (const [key, watcher] of this.watchers) {
        if (desired.has(key)) continue;
        watcher.close();
        this.watchers.delete(key);
      }
      this.watchRoles.clear();
      for (const [key, role] of desired) {
        this.watchRoles.set(key, role);
        if (!this.watchers.has(key) && !this.attachWatcher(key)) complete = false;
      }
      this.watchIncomplete = !complete;
      if (!complete) this.scheduleWatchRetry();
    })().finally(() => { this.watchSyncPromise = undefined; });
    return this.watchSyncPromise;
  }

  private async collectWatchDirectories(directory: string, depth: number, out: Map<string, "tree" | "skill">, optional = false): Promise<boolean> {
    if (out.size >= this.limits.maxWatchDirectories) return false;
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const canonical = await realpath(directory);
      if (!samePath(canonical, directory)) return false;
      const items = await readdir(directory, { withFileTypes: true });
      const hasSkillFile = items.some((item) => item.name === "SKILL.md" && item.isFile());
      const key = pathKey(canonical);
      out.set(key, hasSkillFile ? "skill" : "tree");
      if (hasSkillFile || depth >= this.limits.maxDepth) return true;
      let complete = true;
      for (const item of items) {
        if (!item.isDirectory() || item.isSymbolicLink() || item.name === ".git" || item.name === "node_modules") continue;
        if (out.size >= this.limits.maxWatchDirectories) { complete = false; break; }
        complete = await this.collectWatchDirectories(path.join(canonical, item.name), depth + 1, out) && complete;
      }
      return complete;
    } catch {
      return optional;
    }
  }

  private attachWatcher(directory: string): boolean {
    try {
      const watcher = fsWatch(directory, { persistent: false }, (eventType, filename) => this.handleWatchEvent(directory, eventType, filename));
      watcher.on("error", () => this.handleWatchError(directory));
      this.watchers.set(directory, watcher);
      return true;
    } catch {
      return false;
    }
  }

  private handleWatchEvent(directory: string, eventType: string, filename: string | Buffer | null): void {
    if (this.control?.signal.aborted) return;
    const name = filename === null ? "" : filename.toString();
    const role = this.watchRoles.get(pathKey(directory));
    if (name === "SKILL.md" || (role !== "skill" && eventType === "rename")) this.scheduleCatalogInvalidation();
  }

  private handleWatchError(directory: string): void {
    const key = pathKey(directory);
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    this.watchIncomplete = true;
    this.scheduleCatalogInvalidation();
    this.scheduleWatchRetry();
  }

  private scheduleCatalogInvalidation(): void {
    if (this.watchDebounceTimer !== undefined) clearTimeout(this.watchDebounceTimer);
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = undefined;
      if (this.control?.signal.aborted) return;
      void this.syncWatchers();
      this.control?.invalidate();
    }, 250);
    this.watchDebounceTimer.unref?.();
  }

  private scheduleWatchRetry(): void {
    if (this.watchRetryTimer !== undefined || this.control?.signal.aborted) return;
    this.watchRetryTimer = setTimeout(() => {
      this.watchRetryTimer = undefined;
      void this.syncWatchers();
    }, 1_000);
    this.watchRetryTimer.unref?.();
  }

  private async scan(options: SkillLookupOptions, force: boolean): Promise<SkillProviderObservation> {
    const contextKey = this.contextKey(options);
    const previous = this.lastGoodByContext.get(contextKey);
    const next = new Map<string, Entry>();
    let complete = true;
    let seen = 0;
    for (const root of this.roots) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
      const isDefaultProjectRoot = root.kind === "project" && path.basename(root.path).toLowerCase() === "skills" && path.basename(path.dirname(root.path)).toLowerCase() === ".claude";
      const effectiveRoot = isDefaultProjectRoot && options.cwd !== undefined ? { ...root, path: path.join(path.resolve(options.cwd), ".claude", "skills") } : root;
      if (this.watchEnabled) this.watchTargets.set(pathKey(effectiveRoot.path), effectiveRoot);
      const result = await this.scanRoot(effectiveRoot, options, next, seen);
      complete = complete && result.complete;
      seen += result.count;
      if (seen >= this.limits.maxSkills) { complete = false; break; }
    }
    if (complete) this.lastGoodByContext.set(contextKey, next);
    if (force) this.control?.invalidate();
    const entries = [...(complete ? next : previous ?? new Map<string, Entry>()).values()].slice(0, this.limits.maxSkills);
    if (this.watchEnabled) await this.syncWatchers();
    return { candidates: entries.filter((entry) => isConditionallyActive(entry.candidate, options.paths)).map((entry) => entry.candidate), complete: complete && !this.watchIncomplete };
  }

  private async scanRoot(root: SkillFilesystemRoot, options: SkillLookupOptions, out: Map<string, Entry>, offset: number): Promise<{ complete: boolean; count: number }> {
    let rootPath: string;
    try {
      const info = await lstat(root.path);
      if (!info.isDirectory() || info.isSymbolicLink()) return { complete: false, count: 0 };
      rootPath = await realpath(root.path);
      if (!samePath(rootPath, root.path)) return { complete: false, count: 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && root.optional === true) return { complete: true, count: 0 };
      return { complete: false, count: 0 };
    }
    const found = new Set<string>();
    let complete = true;
    const walk = async (dir: string, depth: number, inherited: readonly string[] = []): Promise<void> => {
      if (depth > this.limits.maxDepth || found.size + offset >= this.limits.maxSkills) { complete = false; return; }
      const local = await readIgnorePatterns(dir);
      const ignored = [...inherited, ...local];
      let items;
      try { items = await readdir(dir, { withFileTypes: true }); } catch { complete = false; return; }
      for (const item of items) {
        if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
        if (item.name === ".git" || item.name === "node_modules") continue;
        const full = path.join(dir, item.name);
        if (matchesIgnore(path.relative(rootPath, full), ignored, item.isDirectory())) continue;
        if (item.isSymbolicLink()) { complete = false; continue; }
        if (item.isDirectory()) {
          if (item.name === ".gitignore") continue;
          await walk(full, depth + 1, ignored);
          continue;
        }
        if (!item.isFile() || item.name !== "SKILL.md") continue;
        try {
          const canonical = await realpath(full);
          const canonicalKey = process.platform === "win32" ? canonical.toLowerCase() : canonical;
          if (!samePath(canonical, full) || !isWithin(rootPath, canonical) || found.has(canonicalKey)) continue;
          const stat = await lstat(full);
          if (stat.size > this.limits.maxFileBytes) { complete = false; continue; }
          const parsed = parseSkillMarkdown(await readFile(full, "utf8"), this.limits.maxDescriptionBytes);
          if (parsed === undefined || !isSkillName(parsed.name)) { complete = false; continue; }
          found.add(canonicalKey);
          const skillDirectory = path.dirname(canonical);
          const locator: FileSkillLocator = { kind: "filesystem", skillFilePath: canonical, skillDirectory };
          const candidate: SkillCandidate = { name: parsed.name, description: parsed.description, ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }), invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable }, source: root.kind, provider: this.name, trust: root.kind === "bundled" ? "bundled" : "local", resourceBase: { kind: "directory", path: skillDirectory }, rank: root.rank ?? DEFAULT_RANK[root.kind], locator, path: canonical, metadata: { ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }), ...(parsed.paths === undefined ? {} : { paths: parsed.paths }), ...(parsed.unknown.length === 0 ? {} : { unknownProperties: parsed.unknown }) } };
          const previous = out.get(parsed.name);
          if (previous === undefined || candidate.rank < previous.candidate.rank) out.set(parsed.name, { candidate, filePath: canonical, skillDirectory, root });
        } catch { complete = false; }
      }
    };
    await walk(rootPath, 0);
    return { complete, count: found.size };
  }

  private contextKey(options: SkillLookupOptions): string {
    return JSON.stringify({ cwd: options.cwd === undefined ? undefined : path.resolve(options.cwd), roots: this.roots.map((root) => ({ kind: root.kind, path: root.path, rank: root.rank ?? DEFAULT_RANK[root.kind], optional: root.optional === true })), limits: this.limits });
  }

  private visibleToTenant(tenantId: string | undefined): boolean {
    return this.tenantId === undefined || tenantId !== undefined && this.tenantId === tenantId;
  }
}

export function defaultSkillFilesystemRoots(options: { readonly cwd?: string; readonly bundledPath?: string; readonly userPath?: string; readonly customPaths?: readonly string[] } = {}): readonly SkillFilesystemRoot[] {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const systemPath = path.join(os.homedir(), ".codex", "skills", ".system");
  return [
    { kind: "project", path: path.join(cwd, ".claude", "skills"), optional: true },
    { kind: "user", path: options.userPath ?? path.join(os.homedir(), ".claude", "skills"), optional: true },
    ...(options.customPaths ?? []).map((item) => ({ kind: "custom" as const, path: item })),
    ...(options.bundledPath === undefined ? [] : [{ kind: "bundled" as const, path: options.bundledPath }]),
    ...(existsSync(systemPath) && systemPath !== options.bundledPath ? [{ kind: "bundled" as const, path: systemPath, optional: true }] : []),
  ];
}

export const LocalSkillProvider = FileSystemSkillProvider;
export function createFileSystemSkillProvider(options: SkillFilesystemProviderOptions): FileSystemSkillProvider { return new FileSystemSkillProvider(options); }

function isWithin(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function pathKey(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }

function readOnlyNoFollowFlags(): number | string {
  // O_NOFOLLOW blocks a final symlink on POSIX. The post-open stat/realpath
  // checks below provide the equivalent fail-closed gate on platforms that do
  // not expose the flag (notably Windows).
  return fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/u).length;
}

function parseFileSkillLocator(value: unknown): FileSkillLocator | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<FileSkillLocator>;
  if (candidate.kind !== "filesystem" || typeof candidate.skillFilePath !== "string" || typeof candidate.skillDirectory !== "string") return undefined;
  return candidate as FileSkillLocator;
}

function validateResourcePath(value: unknown, maxBytes: number): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) return true;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return true;
  const segments = normalized.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function mediaTypeForPath(value: string): string {
  const extension = path.extname(value).toLowerCase();
  switch (extension) {
    case ".md": case ".markdown": return "text/markdown; charset=utf-8";
    case ".json": case ".jsonl": return "application/json; charset=utf-8";
    case ".yaml": case ".yml": return "application/yaml; charset=utf-8";
    case ".toml": return "application/toml; charset=utf-8";
    case ".xml": return "application/xml; charset=utf-8";
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": case ".mjs": case ".cjs": case ".ts": case ".tsx": case ".jsx": return "text/javascript; charset=utf-8";
    case ".sh": case ".bash": case ".zsh": case ".ps1": case ".bat": case ".cmd": return "text/plain; charset=utf-8";
    case ".txt": case ".log": case ".csv": return "text/plain; charset=utf-8";
    default: return "text/plain; charset=utf-8";
  }
}

function parseSkillMarkdown(text: string, maxDescriptionBytes: number): Parsed | undefined {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/u);
  if (match === null) return undefined;
  const values = new Map<string, string>();
  const unknown: string[] = [];
  const frontmatter = match[1];
  if (frontmatter === undefined) return undefined;
  for (const line of frontmatter.split(/\r?\n/u)) {
    const item = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/u);
    if (item === null) { if (line.trim() !== "") unknown.push("malformed"); continue; }
    const key = item[1]; const rawValue = item[2];
    if (key === undefined || rawValue === undefined) { unknown.push("malformed"); continue; }
    if (!FRONTMATTER_KEYS.has(key)) unknown.push(key);
    values.set(key, stripYaml(rawValue));
  }
  const name = values.get("name")?.trim();
  const description = values.get("description")?.trim();
  if (name === undefined || description === undefined || name === "" || description === "" || Buffer.byteLength(description, "utf8") > maxDescriptionBytes) return undefined;
  const bool = (a: string, b: string, fallback: boolean): boolean => { const raw = values.get(a) ?? values.get(b); return raw === undefined ? fallback : raw !== "false"; };
  const toolsRaw = values.get("allowed-tools") ?? values.get("allowedTools");
  const allowedTools = toolsRaw === undefined ? undefined : parseList(toolsRaw);
  const whenToUse = values.get("when_to_use") ?? values.get("whenToUse");
  const pathsRaw = values.get("paths");
  const paths = pathsRaw === undefined ? undefined : parseList(pathsRaw);
  const disableModelInvocation = values.get("disable-model-invocation");
  return { name, description, ...(whenToUse === undefined ? {} : { whenToUse }), modelInvocable: disableModelInvocation === undefined ? bool("model_invocable", "modelInvocable", true) : disableModelInvocation === "false", userInvocable: values.get("user-invocable") === undefined ? bool("user_invocable", "userInvocable", true) : values.get("user-invocable") !== "false", ...(allowedTools === undefined ? {} : { allowedTools }), ...(paths === undefined ? {} : { paths }), unknown, body: text.slice(match[0].length) };
}

function parseList(value: string): readonly string[] { return value.replace(/^\[/u, "").replace(/\]$/u, "").split(/[;,\s]+/u).map((item) => stripYaml(item.trim())).filter(Boolean); }

function isConditionallyActive(candidate: SkillCandidate, paths: readonly string[] | undefined): boolean {
  const rules = Array.isArray(candidate.metadata?.paths) ? candidate.metadata.paths.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  if (rules.length === 0 || paths === undefined || paths.length === 0) return true;
  return paths.some((value) => rules.some((rule) => matchesPathRule(value, rule)));
}

function matchesPathRule(value: string, rule: string): boolean {
  const normalizedValue = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  const normalizedRule = rule.replaceAll("\\", "/").replace(/^\.\//u, "");
  const marker = "__DOUBLE_STAR_SLASH__";
  const prepared = normalizedRule.replaceAll("**/", marker).replaceAll("**", "__DOUBLE_STAR__");
  const escaped = prepared.split(/(__DOUBLE_STAR_SLASH__|__DOUBLE_STAR__)/u).map((part) => part === marker ? "(?:.*/)?" : part === "__DOUBLE_STAR__" ? ".*" : part.split("*").map(escapeRegExp).join("[^/]*")).join("");
  return new RegExp(`^${escaped}$`, "u").test(normalizedValue) || new RegExp(`(?:^|/)${escaped}$`, "u").test(normalizedValue);
}

function stripYaml(value: string): string { const trimmed = value.trim(); return (trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")) ? trimmed.slice(1, -1) : trimmed; }

async function readIgnorePatterns(root: string): Promise<readonly string[]> {
  try { return (await readFile(path.join(root, ".gitignore"), "utf8")).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")); } catch { return []; }
}

function matchesIgnore(relative: string, patterns: readonly string[], directory: boolean): boolean {
  const normalized = relative.replaceAll(path.sep, "/");
  return patterns.some((raw) => {
    const pattern = raw.replace(/^!/, "").replace(/\/$/u, "").replace(/^\//u, "");
    if (pattern === "") return false;
    const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}${directory ? "(?:/.*)?" : ""}$`, "u");
    return !raw.startsWith("!") && (regex.test(normalized) || regex.test(normalized.split("/").slice(-1)[0] ?? ""));
  });
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
