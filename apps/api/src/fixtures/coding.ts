import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PermissionRequest,
  SessionEventStore,
  SessionId,
  ToolCallId,
  TurnId,
} from "@coding-agent/contracts";
import { brand, type AgentEvent } from "@coding-agent/contracts";
import type { AgentHost } from "@coding-agent/runtime";

export type CodingFixtureScenario = "read-only" | "edit" | "test-recovery";

export interface CodingFixtureSession {
  readonly scenario: CodingFixtureScenario;
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly turnId: TurnId;
  readonly toolCallId?: ToolCallId;
  readonly permission?: PermissionRequest;
}

export interface CodingFixtureSeed {
  readonly readOnly: CodingFixtureSession;
  readonly edit: CodingFixtureSession;
  readonly testRecovery: CodingFixtureSession;
}

export interface CodingFixtureSeedOptions {
  readonly host: AgentHost;
  readonly store: SessionEventStore;
  readonly workspaceRoot: string;
  readonly commandPrefix?: string;
}

function turnId(label: string): TurnId {
  return brand<string, "TurnId">(`turn_phase7_${label}_${randomUUID()}`);
}

function toolCallId(value: string): ToolCallId {
  return brand<string, "ToolCallId">(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function appendTurnPrelude(store: SessionEventStore, sessionId: SessionId, id: TurnId, content: string): Promise<void> {
  await store.append({ sessionId, turnId: id, type: "user/message", payload: { content } });
  await store.append({ sessionId, turnId: id, type: "turn/queued", payload: {} });
  await store.append({ sessionId, turnId: id, type: "turn/started", payload: {} });
  await store.append({ sessionId, turnId: id, type: "step/started", payload: { step: 1 } });
}

async function appendTurnCompletion(store: SessionEventStore, sessionId: SessionId, id: TurnId, content: string): Promise<void> {
  await store.append({ sessionId, turnId: id, type: "assistant/message", payload: { content } });
  await store.append({ sessionId, turnId: id, type: "step/ended", payload: { step: 1, status: "completed" } });
  await store.append({ sessionId, turnId: id, type: "turn/ended", payload: { status: "completed" } });
}

function pendingPermission(output: { readonly permission?: PermissionRequest }): PermissionRequest {
  if (output.permission === undefined) throw new Error("Coding fixture expected a pending permission");
  return output.permission;
}

/**
 * Complete the manually seeded turn after a direct user approval resolves the
 * fixture tool. This keeps the fixture on the same event pipeline as a real
 * ToolRuntime execution without adding a production-only command.
 */
export function observeFixtureToolSettlement(options: {
  readonly store: SessionEventStore;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly summary: (event: AgentEvent) => string;
}): () => void {
  let settled = false;
  return options.store.subscribe(options.sessionId, (event) => {
    if (settled || event.type !== "tool/result" || event.payload["toolCallId"] !== options.toolCallId) return;
    settled = true;
    void (async () => {
      await appendTurnCompletion(options.store, options.sessionId, options.turnId, options.summary(event));
    })().catch(() => undefined);
  });
}

/** Seed real tool events for repeatable Phase 7 browser and replay scenarios. */
export async function seedCodingFixture(options: CodingFixtureSeedOptions): Promise<CodingFixtureSeed> {
  const prefix = options.commandPrefix ?? `phase7-coding-${randomUUID()}`;
  const readRoot = join(options.workspaceRoot, "read-only");
  const editRoot = join(options.workspaceRoot, "edit");
  const recoveryRoot = join(options.workspaceRoot, "test-recovery");
  await Promise.all([mkdir(readRoot, { recursive: true }), mkdir(editRoot, { recursive: true }), mkdir(recoveryRoot, { recursive: true })]);

  const readPath = join(readRoot, "fixture.ts");
  await writeFile(readPath, "export const fixtureValue = 42;\n", "utf8");
  const readSession = await options.host.createSession(readRoot, "read-only");
  const readTurn = turnId("read");
  await appendTurnPrelude(options.store, readSession.id, readTurn, "Read-only fixture: inspect fixture.ts and summarize the value.");
  const readOutput = await options.host.executeTool(readSession.id, "read_file", { path: "fixture.ts", offset: 1, limit: 20 }, readTurn, `${prefix}-read`, undefined, "agent");
  if (readOutput.status !== "completed") throw new Error(`Read-only fixture did not complete: ${readOutput.status}`);
  await appendTurnCompletion(options.store, readSession.id, readTurn, "Read-only inspection completed. `fixture.ts` exports `fixtureValue = 42`.");

  const editPath = join(editRoot, "notes.txt");
  const editBefore = "before\n";
  await writeFile(editPath, editBefore, "utf8");
  const editSession = await options.host.createSession(editRoot, "ask-on-write");
  const editTurn = turnId("edit");
  await appendTurnPrelude(options.store, editSession.id, editTurn, "Edit fixture: change notes.txt after approval, then report the diff.");
  const editReadOutput = await options.host.executeTool(editSession.id, "read_file", { path: "notes.txt", offset: 1, limit: 20 }, editTurn, `${prefix}-edit-read`, undefined, "agent");
  if (editReadOutput.status !== "completed") throw new Error(`Edit fixture observation did not complete: ${editReadOutput.status}`);
  const editOutput = await options.host.executeTool(editSession.id, "edit_file", {
    path: "notes.txt",
    expectedHash: hash(editBefore),
    edits: [{ oldText: "before", newText: "after" }],
  }, editTurn, `${prefix}-edit`, undefined, "agent");
  const editPermission = pendingPermission(editOutput);
  const editToolCallId = toolCallId(editOutput.toolCallId);
  observeFixtureToolSettlement({
    store: options.store,
    sessionId: editSession.id,
    turnId: editTurn,
    toolCallId: editToolCallId,
    summary: (event) => event.payload["status"] === "completed" ? "Edit approved. The file diff is ready for review." : "Edit did not complete; inspect the permission and tool result status.",
  });

  const testPath = join(recoveryRoot, "fixture.test.mjs");
  await writeFile(testPath, "console.log('phase7 fixture test passed');\n", "utf8");
  const testSession = await options.host.createSession(recoveryRoot, "ask-on-execute");
  const testTurn = turnId("test-recovery");
  await appendTurnPrelude(options.store, testSession.id, testTurn, "Test/Recovery fixture: run the fixture test after an API restart.");
  const testOutput = await options.host.executeTool(testSession.id, "run_tests", {
    command: "node",
    args: ["-e", "console.log('phase7 fixture test passed')"],
  }, testTurn, `${prefix}-test-recovery`, undefined, "agent");
  const testPermission = pendingPermission(testOutput);
  const testToolCallId = toolCallId(testOutput.toolCallId);

  return {
    readOnly: { scenario: "read-only", sessionId: readSession.id, workspaceRoot: readRoot, turnId: readTurn, toolCallId: readOutput.toolCallId },
    edit: { scenario: "edit", sessionId: editSession.id, workspaceRoot: editRoot, turnId: editTurn, toolCallId: editToolCallId, permission: editPermission },
    testRecovery: { scenario: "test-recovery", sessionId: testSession.id, workspaceRoot: recoveryRoot, turnId: testTurn, toolCallId: testToolCallId, permission: testPermission },
  };
}
