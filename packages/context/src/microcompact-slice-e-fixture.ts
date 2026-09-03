import type { AgentEvent, ChatMessage, ContextBudgetSnapshot } from "@coding-agent/contracts";

/**
 * Deterministic equivalent of the Pylint long-retrieval path used by Slice E.
 * It deliberately contains no checkout-specific source body or provider data.
 */
export const MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE = {
  id: "equivalent-pylint-long-retrieval-v1",
  primaryRequest: "Fix the parser regression, run the targeted tests, and retain the verified handoff.",
  filesRead: ["pylint/checkers/parser.py", "tests/functional/test_parser.py"],
  testCommand: "pnpm --filter @coding-agent/runtime test -- --run parser-regression",
  resultCount: 8,
  resultChars: 800,
  toolName: "read_file",
} as const;

export const MICROCOMPACT_SLICE_E_BUDGET: ContextBudgetSnapshot = {
  capability: {
    provider: "fixture",
    model: "deterministic-long-retrieval",
    maxInputTokens: 10_000,
    maxOutputTokens: 0,
    supportsExactCount: false,
    supportsPromptCache: false,
    source: "estimate",
  },
  reservedOutputTokens: 0,
  effectiveWindowTokens: 10_000,
  autoCompactBufferTokens: 500,
  warningThreshold: 7_000,
  errorThreshold: 7_500,
  autoCompactThreshold: 9_000,
  blockingThreshold: 9_500,
  source: "estimate",
};

export function microcompactSliceELongRetrievalMessages(): readonly ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.primaryRequest }];
  for (let index = 0; index < MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.resultCount; index += 1) {
    const toolCallId = `slice-e-read-${index}`;
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: toolCallId, name: MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.toolName, arguments: "{}" }] });
    messages.push({ role: "tool", toolCallId, toolName: MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.toolName, content: `fixture source evidence ${index}: ${"x".repeat(MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.resultChars)}` });
  }
  return messages;
}

export function microcompactSliceECheckpointEvents(): readonly AgentEvent[] {
  const now = "2026-09-04T00:00:00.000Z";
  return [
    { eventId: "fixture_user", sequence: 1, schemaVersion: 1, sessionId: "fixture" as never, createdAt: now, type: "user/message", payload: { content: MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.primaryRequest } },
    { eventId: "fixture_read", sequence: 2, schemaVersion: 1, sessionId: "fixture" as never, createdAt: now, type: "tool/call", payload: { toolCallId: "slice-e-read-0", name: "read_file", input: { path: MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.filesRead[0] } } },
    { eventId: "fixture_read_result", sequence: 3, schemaVersion: 1, sessionId: "fixture" as never, createdAt: now, type: "tool/result", payload: { toolCallId: "slice-e-read-0", result: { ok: true, output: "fixture output omitted from checkpoint" } } },
    { eventId: "fixture_test", sequence: 4, schemaVersion: 1, sessionId: "fixture" as never, createdAt: now, type: "tool/call", payload: { toolCallId: "slice-e-test", name: "run_command", input: { command: MICROCOMPACT_SLICE_E_LONG_RETRIEVAL_FIXTURE.testCommand } } },
    { eventId: "fixture_test_result", sequence: 5, schemaVersion: 1, sessionId: "fixture" as never, createdAt: now, type: "tool/result", payload: { toolCallId: "slice-e-test", result: { ok: true, output: "targeted tests passed" } } },
  ];
}
