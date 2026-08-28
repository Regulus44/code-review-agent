import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionProjection, ToolResultReplacementRecord } from "@code-review-agent/contracts";
import { artifactAccessResponse, inspectArtifact, isAvailableArtifact } from "./artifacts.js";

function session(workspaceRoot: string, replacement: ToolResultReplacementRecord): SessionProjection {
  return { workspaceRoot, tasks: [], toolResultReplacements: [replacement] } as unknown as SessionProjection;
}

describe("tool-result artifact access", () => {
  it("resolves a replacement artifact through the workspace boundary without exposing an absolute path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "code-review-agent-tool-artifact-"));
    try {
      const relativePath = ".agent-artifacts/tool-results/ses_1/call_1.txt";
      await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await writeFile(path.join(root, relativePath), "complete result", "utf8");
      const replacement: ToolResultReplacementRecord = {
        kind: "tool-result",
        toolCallId: "call_1",
        artifact: { id: "artifact_1", kind: "file", label: "Tool result", path: relativePath, mediaType: "text/plain", sizeBytes: 15 },
        relativePath,
        originalChars: 50_001,
        originalBytes: 50_001,
        originalTokens: 12_501,
        thresholdChars: 50_000,
        preview: "complete",
        previewBytes: 8,
        reason: "max-chars",
      };
      const access = await inspectArtifact(session(root, replacement), "artifact_1");
      expect(access).toBeDefined();
      expect(isAvailableArtifact(access!)).toBe(true);
      expect(access && "filePath" in access ? access.filePath : "").toBe(path.join(root, relativePath));
      expect(artifactAccessResponse(access!)).not.toHaveProperty("filePath");
      expect(JSON.stringify(artifactAccessResponse(access!))).not.toContain(root);
      expect(await inspectArtifact(session(root, replacement), "call_1")).toMatchObject({ availability: "available" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a replacement path that leaves the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "code-review-agent-tool-artifact-"));
    try {
      const replacement: ToolResultReplacementRecord = {
        kind: "tool-result",
        toolCallId: "call_escape",
        artifact: { id: "artifact_escape", kind: "file", label: "Tool result", path: "../outside.txt" },
        relativePath: "../outside.txt",
        originalChars: 50_001,
        originalBytes: 50_001,
        originalTokens: 12_501,
        thresholdChars: 50_000,
        preview: "bounded",
        previewBytes: 7,
        reason: "max-chars",
      };
      const access = await inspectArtifact(session(root, replacement), "artifact_escape");
      expect(access).toMatchObject({ availability: "blocked" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
