import type { ToolResult } from "@code-review-agent/contracts";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WorkspaceResolver } from "@code-review-agent/workspace";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

export async function readWorkspaceImage(root: string, input: { readonly path: string; readonly includeData?: boolean }, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return fail("READ_IMAGE_CANCELLED", "Image read was cancelled");
  const resolver = new WorkspaceResolver(root);
  let target: string;
  try { target = await resolver.resolveExisting(input.path); } catch { return fail("IMAGE_NOT_FOUND", `Image path is outside or missing from the workspace: ${input.path}`); }
  let info;
  try { info = await stat(target); } catch { return fail("IMAGE_NOT_FOUND", `Image path does not exist: ${input.path}`); }
  if (!info.isFile()) return fail("IMAGE_NOT_REGULAR", `Image target is not a file: ${input.path}`);
  if (info.size > MAX_IMAGE_BYTES) return fail("IMAGE_TOO_LARGE", `Image is ${info.size} bytes; the limit is ${MAX_IMAGE_BYTES} bytes.`);
  const bytes = await readFile(target);
  const mediaType = detectMediaType(input.path, bytes);
  if (mediaType === undefined) return fail("IMAGE_TYPE_UNSUPPORTED", `Unsupported or unrecognized image type: ${input.path}`);
  const dimensions = readDimensions(mediaType, bytes);
  const relativePath = path.relative(root, target).replaceAll(path.sep, "/");
  const artifact = { kind: "image", path: relativePath, mediaType, bytes: bytes.byteLength, ...(dimensions === undefined ? {} : dimensions) };
  return { ok: true, output: { artifact, ...(input.includeData === true ? { data: bytes.toString("base64") } : {}) }, audit: { artifact, dataIncluded: input.includeData === true }, presentation: { kind: "tool", title: `Read image ${relativePath}`, data: artifact } };
}

function detectMediaType(filePath: string, bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function readDimensions(mediaType: string, bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (mediaType === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if ((mediaType === "image/gif") && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mediaType === "image/jpeg") return jpegDimensions(bytes);
  return undefined;
}

function jpegDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

function fail(code: string, message: string): ToolResult { return { ok: false, error: { code, message, remedy: code === "IMAGE_TOO_LARGE" ? "Use a smaller bounded image artifact." : "Check the workspace-relative image path and supported media type." }, presentation: { kind: "tool", title: code, text: message } }; }
