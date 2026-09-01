import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ToolResult } from "@coding-agent/contracts";
import { WorkspaceResolver } from "@coding-agent/workspace";

export interface PatchLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly PatchLine[];
}

export interface FilePatch {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: readonly PatchHunk[];
}

export interface PatchFilePreview {
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly unifiedDiff: string;
}

export interface PatchPreview {
  readonly patchId: string;
  readonly files: readonly PatchFilePreview[];
  readonly dryRun: boolean;
}

export interface AppliedPatch extends PatchPreview {
  readonly patch: string;
  readonly before: Readonly<Record<string, string | null>>;
  readonly after: Readonly<Record<string, string | null>>;
  readonly artifactPath?: string;
}

export class PatchParseError extends Error {
  readonly code = "PATCH_INVALID";
}

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_FILES = 100;
const MAX_PATCH_HUNKS = 2_000;

export function parseUnifiedPatch(input: string): readonly FilePatch[] {
  if (Buffer.byteLength(input, "utf8") > MAX_PATCH_BYTES) throw new PatchParseError(`Patch exceeds ${MAX_PATCH_BYTES} bytes`);
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;
  let hunkCount = 0;
  while (index < lines.length) {
    if (lines[index] === "") { index += 1; continue; }
    if (!lines[index]!.startsWith("--- ")) throw new PatchParseError(`Expected a unified diff file header at line ${index + 1}`);
    const oldPath = parseHeaderPath(lines[index]!.slice(4), index + 1);
    index += 1;
    if (index >= lines.length || !lines[index]!.startsWith("+++ ")) throw new PatchParseError(`Expected a new-file header after line ${index}`);
    const newPath = parseHeaderPath(lines[index]!.slice(4), index + 1);
    index += 1;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && lines[index]!.startsWith("@@ ")) {
      hunkCount += 1;
      if (hunkCount > MAX_PATCH_HUNKS) throw new PatchParseError(`Patch exceeds ${MAX_PATCH_HUNKS} hunks`);
      const header = parseHunkHeader(lines[index]!, index + 1);
      index += 1;
      const hunkLines: PatchLine[] = [];
      let oldSeen = 0;
      let newSeen = 0;
      while (index < lines.length && !lines[index]!.startsWith("@@ ") && !lines[index]!.startsWith("--- ")) {
        const line = lines[index]!;
        if (line.startsWith("\\ No newline at end of file")) { index += 1; continue; }
        if (line.startsWith(" ")) { hunkLines.push({ kind: "context", text: line.slice(1) }); oldSeen += 1; newSeen += 1; }
        else if (line.startsWith("-")) { hunkLines.push({ kind: "remove", text: line.slice(1) }); oldSeen += 1; }
        else if (line.startsWith("+")) { hunkLines.push({ kind: "add", text: line.slice(1) }); newSeen += 1; }
        else if (line === "") { hunkLines.push({ kind: "context", text: "" }); oldSeen += 1; newSeen += 1; }
        else throw new PatchParseError(`Invalid hunk line at line ${index + 1}`);
        index += 1;
        if (oldSeen > header.oldCount || newSeen > header.newCount) throw new PatchParseError(`Hunk at line ${header.line} contains more lines than its header declares`);
        if (oldSeen === header.oldCount && newSeen === header.newCount) break;
      }
      if (oldSeen !== header.oldCount || newSeen !== header.newCount) throw new PatchParseError(`Hunk at line ${header.line} is incomplete`);
      hunks.push({ oldStart: header.oldStart, oldCount: header.oldCount, newStart: header.newStart, newCount: header.newCount, lines: hunkLines });
    }
    if (hunks.length === 0) throw new PatchParseError(`File patch at line ${index + 1} has no hunks`);
    files.push({ oldPath, newPath, hunks });
    if (files.length > MAX_PATCH_FILES) throw new PatchParseError(`Patch exceeds ${MAX_PATCH_FILES} files`);
  }
  if (files.length === 0) throw new PatchParseError("Patch is empty");
  return files;
}

export async function previewUnifiedPatch(
  root: string,
  patchText: string,
  expectedHashes: Readonly<Record<string, string>> = {},
): Promise<{ readonly files: readonly PatchFilePreview[]; readonly before: Readonly<Record<string, string | null>>; readonly after: Readonly<Record<string, string | null>> }> {
  const patches = parseUnifiedPatch(patchText);
  const resolver = new WorkspaceResolver(root);
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  const previews: PatchFilePreview[] = [];
  const seen = new Set<string>();
  for (const filePatch of patches) {
    const targetPath = filePatch.newPath ?? filePatch.oldPath;
    if (targetPath === null) throw new PatchParseError("File patch has neither an old nor a new path");
    const displayPath = targetPath;
    if (seen.has(displayPath)) throw new PatchParseError(`Patch contains duplicate target path: ${displayPath}`);
    seen.add(displayPath);
    const oldTarget = filePatch.oldPath === null ? null : resolver.resolve(filePatch.oldPath);
    const newTarget = filePatch.newPath === null ? null : resolver.resolve(filePatch.newPath);
    const current = await readTextIfPresent(resolver, displayPath);
    const expected = expectedHashes[displayPath] ?? (filePatch.oldPath === null ? undefined : expectedHashes[filePatch.oldPath]);
    if (expected !== undefined && hashText(current ?? "") !== expected) throw new PatchConflictError(`Patch base is stale for ${displayPath}; expected ${expected}, current ${hashText(current ?? "")}`);
    const next = applyFilePatch(current, filePatch, displayPath);
    before[displayPath] = current;
    after[displayPath] = next;
    const operation: PatchFilePreview["operation"] = current === null ? "create" : next === null ? "delete" : "update";
    previews.push({
      path: displayPath,
      operation,
      ...(current === null ? {} : { beforeHash: hashText(current) }),
      ...(next === null ? {} : { afterHash: hashText(next) }),
      beforeBytes: Buffer.byteLength(current ?? "", "utf8"),
      afterBytes: Buffer.byteLength(next ?? "", "utf8"),
      unifiedDiff: createUnifiedDiff(displayPath, current ?? "", next ?? ""),
    });
    if (newTarget !== null && oldTarget !== null && path.resolve(newTarget) !== path.resolve(oldTarget)) throw new PatchParseError("Rename-style patches are not supported; submit delete and create as separate file patches");
  }
  return { files: previews, before, after };
}

export async function applyPreview(root: string, preview: Awaited<ReturnType<typeof previewUnifiedPatch>>): Promise<void> {
  const resolver = new WorkspaceResolver(root);
  for (const file of preview.files) {
    const current = await readTextIfPresent(resolver, file.path);
    if (hashText(current ?? "") !== hashText(preview.before[file.path] ?? "")) throw new PatchConflictError(`File changed while applying patch: ${file.path}`);
  }
  try {
    for (const file of preview.files) {
      const target = resolver.resolve(file.path);
      const next = preview.after[file.path];
      if (next === undefined) throw new PatchConflictError(`Patch preview is missing target state: ${file.path}`);
      if (next === null) {
        await rm(target, { force: false });
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        const writable = await resolver.resolveForWrite(file.path);
        await writeFile(writable, next, "utf8");
      }
    }
  } catch (error) {
    await restoreFiles(root, preview.before);
    throw error;
  }
}

export async function restoreFiles(root: string, files: Readonly<Record<string, string | null>>): Promise<void> {
  const resolver = new WorkspaceResolver(root);
  for (const [filePath, content] of Object.entries(files)) {
    const target = resolver.resolve(filePath);
    if (content === null) await rm(target, { force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      const writable = await resolver.resolveForWrite(filePath);
      await writeFile(writable, content, "utf8");
    }
  }
}

export async function persistPatchRecord(root: string, record: AppliedPatch): Promise<string> {
  const artifactPath = patchArtifactPath(root, record.patchId);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify({ ...record, artifactPath: path.relative(path.resolve(root), artifactPath).replaceAll("\\", "/") }), "utf8");
  return artifactPath;
}

export async function loadPatchRecord(root: string, patchId: string): Promise<AppliedPatch | undefined> {
  if (!/^patch_[0-9a-f-]{20,80}$/u.test(patchId)) return undefined;
  try {
    const artifactPath = patchArtifactPath(root, patchId);
    const value: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
    if (!isAppliedPatch(value) || value.patchId !== patchId) return undefined;
    return { ...value, artifactPath: path.relative(path.resolve(root), artifactPath).replaceAll("\\", "/") };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function removePatchRecord(root: string, patchId: string): Promise<void> {
  await rm(patchArtifactPath(root, patchId), { force: true });
}

export class PatchConflictError extends Error {
  readonly code = "PATCH_CONFLICT";
}

function parseHeaderPath(value: string, line: number): string | null {
  const token = value.trim().split(/[\t ]/u, 1)[0] ?? "";
  if (token === "/dev/null") return null;
  const normalized = token.replace(/^([ab])\//u, "").replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").some((part) => part === "..")) throw new PatchParseError(`Unsafe patch path at line ${line}`);
  return normalized;
}

function parseHunkHeader(value: string, line: number): PatchHunk & { readonly line: number } {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(value);
  if (match === null) throw new PatchParseError(`Invalid hunk header at line ${line}`);
  return { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [], line };
}

function applyFilePatch(current: string | null, patch: FilePatch, displayPath: string): string | null {
  const oldLines = current === null ? [] : splitLines(current);
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    const expectedCursor = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (expectedCursor < cursor || expectedCursor > oldLines.length) throw new PatchConflictError(`Hunk location is outside ${displayPath}`);
    output.push(...oldLines.slice(cursor, expectedCursor));
    cursor = expectedCursor;
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        if (oldLines[cursor] !== line.text) throw new PatchConflictError(`Context mismatch in ${displayPath} at line ${cursor + 1}`);
        output.push(line.text); cursor += 1;
      } else if (line.kind === "remove") {
        if (oldLines[cursor] !== line.text) throw new PatchConflictError(`Removal mismatch in ${displayPath} at line ${cursor + 1}`);
        cursor += 1;
      } else output.push(line.text);
    }
  }
  output.push(...oldLines.slice(cursor));
  if (patch.oldPath === null && current !== null) throw new PatchConflictError(`Create patch target already exists: ${displayPath}`);
  if (patch.newPath === null) return null;
  return joinLines(output, current);
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  const normalized = value.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function joinLines(lines: readonly string[], original: string | null): string {
  const text = lines.join("\n");
  return `${text}${original?.endsWith("\n") === true ? "\n" : ""}`;
}

function createUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  return [`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -${prefix + 1},${Math.max(removed.length, 1)} +${prefix + 1},${Math.max(added.length, 1)} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
}

async function readTextIfPresent(resolver: WorkspaceResolver, filePath: string): Promise<string | null> {
  const candidate = resolver.resolve(filePath);
  try {
    await access(candidate);
    const target = await resolver.resolveExisting(filePath);
    const info = await stat(target);
    if (!info.isFile()) throw new PatchConflictError(`Patch target is not a regular file: ${filePath}`);
    const buffer = await readFile(target);
    if (buffer.includes(0)) throw new PatchConflictError(`Patch target is binary: ${filePath}`);
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof PatchConflictError) throw error;
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hashText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function patchArtifactPath(root: string, patchId: string): string { return path.join(path.resolve(root), ".agent-artifacts", "patches", `${patchId}.json`); }

function isAppliedPatch(value: unknown): value is AppliedPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["patchId"] === "string" && typeof candidate["patch"] === "string" && typeof candidate["dryRun"] === "boolean" && Array.isArray(candidate["files"]) && isStringMap(candidate["before"]) && isStringMap(candidate["after"]);
}

function isStringMap(value: unknown): value is Readonly<Record<string, string | null>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((item) => item === null || typeof item === "string");
}
