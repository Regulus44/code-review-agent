/**
 * Transactional state for the message composer. The draft is snapshotted at
 * submit time and is only released after host admission succeeds; failures
 * keep the exact draft so a transient transport error cannot lose user work.
 */
export type ComposerPhase = "idle" | "submitting" | "error";

export interface ComposerState {
  readonly phase: ComposerPhase;
  readonly draft?: string;
  readonly error?: string;
  readonly attemptId: number;
}

export interface ComposerAttempt {
  readonly id: number;
  readonly draft: string;
}

export function createComposerState(): ComposerState {
  return { phase: "idle", attemptId: 0 };
}

export function beginComposerSubmit(state: ComposerState, draft: string): { readonly state: ComposerState; readonly attempt?: ComposerAttempt } {
  const normalized = draft.trim();
  if (!normalized || state.phase === "submitting") return { state };
  const attemptId = state.attemptId + 1;
  return {
    state: { phase: "submitting", draft: normalized, attemptId },
    attempt: { id: attemptId, draft: normalized },
  };
}

export function settleComposerSubmit(state: ComposerState, attempt: ComposerAttempt, result: "committed" | "failed", error?: string): ComposerState {
  if (state.phase !== "submitting" || state.attemptId !== attempt.id) return state;
  if (result === "committed") return { phase: "idle", attemptId: state.attemptId };
  return { phase: "error", draft: attempt.draft, error: error || "Message could not be sent.", attemptId: state.attemptId };
}

export function releaseComposerError(state: ComposerState): ComposerState {
  if (state.phase !== "error") return state;
  return { phase: "idle", attemptId: state.attemptId };
}
