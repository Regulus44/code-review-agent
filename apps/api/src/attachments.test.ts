import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionProjection } from "@coding-agent/contracts";
import { AttachmentInputError, attachmentCapability, stageAttachment } from "./attachments.js";

function session(workspaceRoot: string): SessionProjection {
  return { workspaceRoot } as SessionProjection;
}

describe("attachment staging", () => {
  it("stores a bounded workspace-relative file and returns a receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-attachment-"));
    try {
      const receipt = await stageAttachment(session(root), { fileName: "notes.md", mediaType: "text/markdown", data: Buffer.from("hello").toString("base64") }, attachmentCapability(), "cmd-attachment-1");
      expect(receipt).toMatchObject({ status: "accepted", fileName: "notes.md", mediaType: "text/markdown", sizeBytes: 5, relativePath: expect.stringContaining(".agent-artifacts/attachments/") });
      expect(await readFile(path.join(root, receipt.relativePath!), "utf8")).toBe("hello");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects disallowed, oversized and image uploads without creating files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-attachment-"));
    try {
      const denied = await stageAttachment(session(root), { fileName: "secret.exe", mediaType: "application/x-msdownload", data: Buffer.from("x").toString("base64") }, attachmentCapability(), "cmd-attachment-2");
      expect(denied).toMatchObject({ status: "rejected", code: "ATTACHMENT_MEDIA_TYPE_DENIED" });
      const large = await stageAttachment(session(root), { fileName: "large.txt", mediaType: "text/plain", data: Buffer.from("123456").toString("base64") }, attachmentCapability({ maxBytes: 5 }), "cmd-attachment-3");
      expect(large).toMatchObject({ status: "rejected", code: "ATTACHMENT_TOO_LARGE", sizeBytes: 6 });
      const image = await stageAttachment(session(root), { fileName: "image.png", mediaType: "image/png", data: Buffer.from("png").toString("base64") }, attachmentCapability(), "cmd-attachment-4");
      expect(image).toMatchObject({ status: "rejected", code: "ATTACHMENT_IMAGE_UNAVAILABLE" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects traversal names before touching the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-attachment-"));
    try {
      await expect(stageAttachment(session(root), { fileName: "../secret.txt", mediaType: "text/plain", data: Buffer.from("x").toString("base64") }, attachmentCapability(), "cmd-attachment-5")).rejects.toBeInstanceOf(AttachmentInputError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
