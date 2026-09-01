import type { ArtifactRef, ChildReportInput, TaskBudget, TaskId, ToolDefinition, ToolResult } from "@coding-agent/contracts";
import type { SubagentRuntime, SpawnSubagentRequest } from "@coding-agent/subagent";

export interface SubagentToolOptions {
  readonly runtime: SubagentRuntime;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("SUBAGENT_INPUT_INVALID");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`SUBAGENT_${key.toUpperCase()}_REQUIRED`);
  return value;
}

function taskId(input: Record<string, unknown>): TaskId {
  return requiredString(input, "taskId") as TaskId;
}

function success(output: unknown): ToolResult {
  return { ok: true, output, modelView: output };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "SUBAGENT_TOOL_FAILED";
  return { ok: false, error: { code, message } };
}

const permissionEnum = ["read-only", "workspace-write", "ask-on-write", "ask-on-execute", "workspace-full-access", "danger-full-access"];

export function createSubagentTools(options: SubagentToolOptions): readonly ToolDefinition[] {
  const runtime = options.runtime;
  return [
    {
      name: "spawn_subagent",
      description: "Start an independent one-shot or continuable child with explicit workspace, permission, tool and MCP scope.",
      inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "permissionPreset"], properties: { prompt: { type: "string", minLength: 1 }, mode: { enum: ["one-shot", "continuable"] }, background: { type: "boolean" }, label: { type: "string" }, provider: { type: "string" }, permissionPreset: { enum: permissionEnum }, toolAllowlist: { type: "array", items: { type: "string" } }, mcpAllowlist: { type: "array", items: { type: "string" } }, model: { type: "string" }, delegationDepth: { type: "integer", minimum: 0 }, budget: { type: "object" }, outputSchema: { type: "object" } } },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => {
        try {
          const input = inputRecord(rawInput);
          const request: SpawnSubagentRequest = {
            parentSessionId: context.sessionId,
            prompt: requiredString(input, "prompt"),
            workspaceRoot: context.workspaceRoot,
            permissionPreset: (input["permissionPreset"] as SpawnSubagentRequest["permissionPreset"]),
            ...(input["mode"] === "one-shot" || input["mode"] === "continuable" ? { mode: input["mode"] } : {}),
            ...(typeof input["background"] === "boolean" ? { background: input["background"] } : {}),
            ...(typeof input["label"] === "string" ? { label: input["label"] } : {}),
            ...(typeof input["provider"] === "string" ? { provider: input["provider"] } : {}),
            ...(Array.isArray(input["toolAllowlist"]) ? { toolAllowlist: input["toolAllowlist"] as string[] } : {}),
            ...(Array.isArray(input["mcpAllowlist"]) ? { mcpAllowlist: input["mcpAllowlist"] as string[] } : {}),
            ...(typeof input["model"] === "string" ? { model: input["model"] } : {}),
            ...(typeof input["delegationDepth"] === "number" ? { delegationDepth: input["delegationDepth"] } : {}),
            ...(typeof input["budget"] === "object" && input["budget"] !== null ? { budget: input["budget"] as TaskBudget } : {}),
            ...(typeof input["outputSchema"] === "object" && input["outputSchema"] !== null ? { outputSchema: input["outputSchema"] as Record<string, unknown> } : {}),
          };
          const receipt = await runtime.spawn(request);
          return success(receipt);
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "task_query",
      description: "Read a bounded durable child task projection; queued and ready are not completed.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", minLength: 1 } } },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => { try { const task = await runtime.taskQuery(context.sessionId, taskId(inputRecord(rawInput))); return task === undefined ? failure({ code: "TASK_NOT_FOUND", message: "Task not found" }) : success(task); } catch (error) { return failure(error); } },
    },
    {
      name: "report",
      description: "Send a bounded progress report from a continuable child to its durable direct parent; recipient is derived, never caller-selected.",
      inputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", minLength: 1, maxLength: 4096 }, output: {}, artifacts: { type: "array", items: { type: "object" } }, delivery: { enum: ["wakeup", "quiet"] } } },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => {
        try {
          const input = inputRecord(rawInput);
          return success(await runtime.report(context.sessionId, { summary: requiredString(input, "summary"), ...(input["output"] === undefined ? {} : { output: input["output"] }), ...(Array.isArray(input["artifacts"]) ? { artifacts: input["artifacts"] as readonly ArtifactRef[] } : {}), ...(input["delivery"] === "wakeup" || input["delivery"] === "quiet" ? { delivery: input["delivery"] } : {}) }));
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "task_output",
      description: "Read a bounded final report, diagnostics and artifact manifest without injecting the full child transcript.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", minLength: 1 } } },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => { try { const output = await runtime.taskOutput(context.sessionId, taskId(inputRecord(rawInput))); return output === undefined ? failure({ code: "TASK_NOT_FOUND", message: "Task not found" }) : success({ task: output.task, report: output.report, childEventCount: output.events.length }); } catch (error) { return failure(error); } },
    },
    {
      name: "task_cancel",
      description: "Cancel a child task idempotently; cancellation does not erase its durable output or queued inbox.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", minLength: 1 } } },
      executionMode: "exclusive",
      riskLevel: "write",
      approvalMode: "ask",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => { try { return success(await runtime.cancel(context.sessionId, taskId(inputRecord(rawInput)))); } catch (error) { return failure(error); } },
    },
    {
      name: "send_message",
      description: "Queue a message for the next turn of a continuable child; it never redirects the current turn.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId", "prompt"], properties: { taskId: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } } },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => { try { const input = inputRecord(rawInput); return success(await runtime.sendMessage(context.sessionId, taskId(input), requiredString(input, "prompt"))); } catch (error) { return failure(error); } },
    },
    {
      name: "interrupt_agent",
      description: "Interrupt only the current child turn; queued inbox messages and descendants remain durable.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", minLength: 1 } } },
      executionMode: "exclusive",
      riskLevel: "write",
      approvalMode: "ask",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => { try { return success(await runtime.interrupt(context.sessionId, taskId(inputRecord(rawInput)))); } catch (error) { return failure(error); } },
    },
    {
      name: "list_agents",
      description: "List durable direct children or descendants. Ready means cold-resumable, not completed.",
      inputSchema: { type: "object", additionalProperties: false, properties: { scope: { enum: ["children", "descendants"] } } },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (rawInput, context) => { try { const input = inputRecord(rawInput); return success(await runtime.agentCatalog(context.sessionId, input["scope"] === "descendants" ? "descendants" : "children")); } catch (error) { return failure(error); } },
    },
  ];
}
