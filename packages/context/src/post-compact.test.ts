import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@coding-agent/contracts";
import { createCompactBoundaryMessage, getMessagesAfterCompactBoundary } from "./boundary.js";
import { selectPostCompactAttachments } from "./attachments.js";
import { buildPostCompactMessages } from "./post-compact.js";

describe("compact boundary and post-compact rebuild", () => {
  it("creates a durable boundary and preserves head/anchor/tail metadata", () => {
    const boundary = createCompactBoundaryMessage({
      id: "boundary-test",
      kind: "summary",
      trigger: "auto",
      preCompactTokens: 1234,
      sourceSequence: 17,
      messagesSummarized: 4,
    });
    const result = buildPostCompactMessages({
      boundary: {
        id: "boundary-test",
        kind: "summary",
        trigger: "auto",
        preCompactTokens: 1234,
        sourceSequence: 17,
        messagesSummarized: 4,
      },
      summaryMessages: [{ role: "user", content: "historical summary" }],
      preservedMessages: [
        { role: "user", content: "recent", messageId: "m-head" },
        { role: "assistant", content: "answer", messageId: "m-tail" },
      ],
      attachments: [{ id: "plan-1", kind: "plan", content: "keep this plan" }],
    });
    expect(result.messages[0]).toMatchObject({ role: "system", messageId: "boundary-test" });
    expect(result.boundary.contextBoundary?.preservedSegment).toEqual({ headMessageId: "m-head", anchorMessageId: "boundary-test", tailMessageId: "m-tail" });
    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "user"]);
    expect(boundary.contextBoundary?.sourceSequence).toBe(17);
  });

  it("orders boundary, summary, preserved messages, and bounded attachments", () => {
    const result = buildPostCompactMessages({
      boundary: { kind: "summary", trigger: "auto", preCompactTokens: 100, sourceSequence: 2 },
      summaryMessages: [{ role: "user", content: "summary" }],
      preservedMessages: [{ role: "user", content: "recent" }],
      attachments: [
        { id: "file-a", kind: "file", content: "A" },
        { id: "file-a", kind: "file", content: "duplicate" },
        { id: "skill-a", kind: "skill", content: "skill" },
      ],
      attachmentConfig: { maxRecentFiles: 1, maxAttachmentTokens: 100 },
    });
    expect(result.messages.at(-2)?.content).toContain('id="file-a"');
    expect(result.messages.at(-1)?.content).toContain('id="skill-a"');
    expect(result.droppedAttachmentIds).toContain("file-a");
  });

  it("does not re-inject an attachment already present in preserved messages", () => {
    const preserved: ChatMessage = { role: "user", content: '<context-attachment id="file-a" kind="file">\nold\n</context-attachment>' };
    const result = buildPostCompactMessages({
      boundary: { kind: "summary", trigger: "auto", preCompactTokens: 100, sourceSequence: 2 },
      preservedMessages: [preserved],
      attachments: [{ id: "file-a", kind: "file", content: "new" }],
    });
    expect(result.messages).toHaveLength(2);
    expect(result.droppedAttachmentIds).toEqual(["file-a"]);
  });

  it("enforces file count and total attachment token budgets", () => {
    const result = selectPostCompactAttachments(
      [
        { id: "f1", kind: "file", content: "x".repeat(100) },
        { id: "f2", kind: "file", content: "x".repeat(100) },
        { id: "f3", kind: "file", content: "x".repeat(100) },
      ],
      { maxRecentFiles: 2, maxAttachmentTokens: 20, maxTokensPerAttachment: 20 },
    );
    expect(result.attachments.length).toBeLessThanOrEqual(2);
    expect(result.estimatedTokens).toBeLessThanOrEqual(20);
    expect(result.droppedAttachmentIds.length).toBeGreaterThan(0);
  });

  it("replays the latest boundary segment without changing the input array", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old" },
      createCompactBoundaryMessage({ id: "b", kind: "summary", trigger: "auto", preCompactTokens: 1, sourceSequence: 1 }),
      { role: "user", content: "new" },
    ];
    const sliced = getMessagesAfterCompactBoundary(messages);
    expect(sliced).toHaveLength(2);
    expect(messages).toHaveLength(3);
  });
});
