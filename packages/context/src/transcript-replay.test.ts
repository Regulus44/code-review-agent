import { describe, expect, it } from "vitest";
import { restoreModelViewFromTranscript } from "./transcript-replay.js";

describe("transcript replay", () => {
  const transcript = [
    { role: "user" as const, content: "old", messageId: "old" },
    { role: "assistant" as const, content: "kept", messageId: "head" },
    { role: "user" as const, content: "recent", messageId: "tail" },
  ];

  it("rebuilds boundary, summary and preserved suffix from durable metadata", () => {
    const result = restoreModelViewFromTranscript({
      transcript,
      boundary: { version: 1, id: "boundary-1", kind: "summary", trigger: "auto", preCompactTokens: 900, sourceSequence: 4, preservedSegment: { headMessageId: "head", anchorMessageId: "boundary-1", tailMessageId: "tail" }, createdAt: "2026-08-26T00:00:00.000Z", algorithmVersion: "m10.v1" },
      segment: { version: 1, boundaryId: "boundary-1", algorithmVersion: "m10.v1", sourceSequence: 4, headMessageId: "head", anchorMessageId: "boundary-1", tailMessageId: "tail", createdAt: "2026-08-26T00:00:00.000Z" },
      summary: "bounded summary",
    });
    expect(result).toMatchObject({ mode: "boundary", reason: "boundary_replayed", algorithmVersion: "m10.v1" });
    expect(result.messages.map((message) => message.content)).toEqual(["Conversation compacted", "bounded summary", "kept", "recent"]);
  });

  it("falls back to the complete transcript when the durable anchor is stale", () => {
    const result = restoreModelViewFromTranscript({
      transcript,
      boundary: { version: 1, id: "boundary-1", kind: "summary", trigger: "auto", preCompactTokens: 900, sourceSequence: 4, preservedSegment: { headMessageId: "gone" }, createdAt: "2026-08-26T00:00:00.000Z" },
    });
    expect(result).toMatchObject({ mode: "legacy", reason: "boundary_head_missing" });
    expect(result.messages).toEqual(transcript);
  });

  it("does not replay a segment when its boundary metadata is missing or mismatched", () => {
    const missingBoundary = restoreModelViewFromTranscript({
      transcript,
      segment: { version: 1, boundaryId: "boundary-1", algorithmVersion: "m10.v1", sourceSequence: 4, headMessageId: "head", createdAt: "2026-08-26T00:00:00.000Z" },
    });
    expect(missingBoundary).toMatchObject({ mode: "legacy", reason: "boundary_without_head", messages: transcript });

    const mismatched = restoreModelViewFromTranscript({
      transcript,
      boundary: { version: 1, id: "boundary-1", kind: "summary", trigger: "auto", preCompactTokens: 900, sourceSequence: 4, preservedSegment: { headMessageId: "head" }, createdAt: "2026-08-26T00:00:00.000Z" },
      segment: { version: 1, boundaryId: "boundary-other", algorithmVersion: "m10.v1", sourceSequence: 99, headMessageId: "head", createdAt: "2026-08-26T00:00:00.000Z" },
    });
    expect(mismatched).toMatchObject({ mode: "legacy", reason: "boundary_mismatch", messages: transcript });
  });

  it("does not mutate durable transcript while rebuilding the view", () => {
    const durableTranscript = transcript.map(message => ({ ...message }));
    const result = restoreModelViewFromTranscript({
      transcript: durableTranscript,
      boundary: { version: 1, id: "boundary-1", kind: "summary", trigger: "auto", preCompactTokens: 900, sourceSequence: 4, preservedSegment: { headMessageId: "head" }, createdAt: "2026-08-26T00:00:00.000Z" },
      summary: "bounded summary",
    });
    expect(durableTranscript).toEqual(transcript);
    expect(result.messages).not.toBe(durableTranscript);
  });

  it("keeps legacy sessions unchanged when no boundary exists", () => {
    expect(restoreModelViewFromTranscript({ transcript })).toMatchObject({ mode: "legacy", reason: "no_boundary", messages: transcript });
  });
});
