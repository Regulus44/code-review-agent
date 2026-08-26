import type {
  ChatMessage,
  ContextBoundaryMetadata,
  ContextTranscriptSegment,
} from "@code-review-agent/contracts";
import { boundaryFromMetadata } from "./boundary.js";

export interface TranscriptRestoreInput {
  readonly transcript: readonly ChatMessage[];
  readonly boundary?: ContextBoundaryMetadata;
  readonly segment?: ContextTranscriptSegment;
  readonly summary?: string;
}

export interface TranscriptRestoreResult {
  readonly messages: readonly ChatMessage[];
  readonly mode: "boundary" | "legacy";
  readonly reason: "boundary_replayed" | "no_boundary" | "boundary_without_head" | "boundary_head_missing" | "boundary_mismatch";
  readonly boundaryId?: string;
  readonly algorithmVersion?: string;
  readonly sourceSequence?: number;
}

/**
 * Rebuilds the model-visible suffix from the durable transcript without
 * mutating the transcript itself. A missing or stale anchor deliberately
 * falls back to the complete transcript instead of guessing a cut point.
 */
export function restoreModelViewFromTranscript(input: TranscriptRestoreInput): TranscriptRestoreResult {
  const transcript = [...input.transcript];
  const boundary = input.boundary;
  const segment = input.segment;
  if (boundary === undefined && segment === undefined) return { messages: transcript, mode: "legacy", reason: "no_boundary" };

  const headMessageId = segment?.headMessageId ?? boundary?.preservedSegment?.headMessageId;
  const boundaryId = segment?.boundaryId ?? boundary?.id;
  const algorithmVersion = segment?.algorithmVersion ?? boundary?.algorithmVersion ?? "legacy-boundary-v1";
  const sourceSequence = segment?.sourceSequence ?? boundary?.sourceSequence;
  if (boundary === undefined) return fallback(input, "boundary_without_head", boundaryId, algorithmVersion, sourceSequence);
  if (
    segment !== undefined &&
    (segment.boundaryId !== boundary.id ||
      segment.sourceSequence !== boundary.sourceSequence ||
      (segment.anchorMessageId !== undefined && segment.anchorMessageId !== boundary.id) ||
      (boundary.algorithmVersion !== undefined && segment.algorithmVersion !== boundary.algorithmVersion))
  ) return fallback(input, "boundary_mismatch", boundaryId, algorithmVersion, sourceSequence);
  if (headMessageId === undefined) return fallback(input, "boundary_without_head", boundaryId, algorithmVersion, sourceSequence);
  const preservedIndex = transcript.findIndex((message) => message.messageId === headMessageId);
  if (preservedIndex < 0) return fallback(input, "boundary_head_missing", boundaryId, algorithmVersion, sourceSequence);

  const marker = boundary === undefined
    ? undefined
    : boundaryFromMetadata(boundary);
  return {
    messages: [
      ...(marker === undefined ? [] : [marker]),
      ...(input.summary === undefined || input.summary.length === 0 ? [] : [{ role: "user" as const, content: input.summary }]),
      ...transcript.slice(preservedIndex),
    ],
    mode: "boundary",
    reason: "boundary_replayed",
    ...(boundaryId === undefined ? {} : { boundaryId }),
    ...(algorithmVersion === undefined ? {} : { algorithmVersion }),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
  };
}

function fallback(input: TranscriptRestoreInput, reason: "boundary_without_head" | "boundary_head_missing" | "boundary_mismatch", boundaryId: string | undefined, algorithmVersion: string | undefined, sourceSequence: number | undefined): TranscriptRestoreResult {
  return {
    messages: [...input.transcript],
    mode: "legacy",
    reason,
    ...(boundaryId === undefined ? {} : { boundaryId }),
    ...(algorithmVersion === undefined ? {} : { algorithmVersion }),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
  };
}
