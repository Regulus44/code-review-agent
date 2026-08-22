import { type ChatModel, type SessionEventStore, type TaskReport, type ToolDefinition } from "@code-review-agent/contracts";
import { ToolRegistry } from "@code-review-agent/tools";
import { AgentHost, type AgentHostOptions } from "./index.js";
import type { ProviderRun, ProviderRunContext, ProviderCapabilities, SubagentProvider } from "@code-review-agent/subagent";

export interface InProcessProviderOptions {
  readonly store: SessionEventStore;
  readonly model?: ChatModel;
  readonly baseToolDefinitions?: readonly ToolDefinition[];
  readonly subagentRuntime?: AgentHostOptions["subagentRuntime"];
  readonly maxSteps?: number;
}

function childRegistry(definitions: readonly ToolDefinition[] | undefined, allowlist: readonly string[] | undefined, mcpAllowlist: readonly string[] | undefined): ToolRegistry | undefined {
  if (definitions === undefined) return undefined;
  const registry = new ToolRegistry();
  const allowed = new Set(allowlist ?? []);
  const allowedMcp = new Set(mcpAllowlist ?? []);
  registry.registerMany(definitions.filter((definition) => {
    if (definition.source?.kind === "mcp") return allowedMcp.has("*") || allowedMcp.has(definition.source.serverName) || allowedMcp.has(definition.name);
    return allowed.has("*") || allowed.has(definition.name);
  }));
  return registry;
}

/** Adapter that runs each child in a fresh AgentHost while retaining the shared EventStore and ToolRuntime contracts. */
export function createInProcessSubagentProvider(options: InProcessProviderOptions): SubagentProvider {
  const capabilities: ProviderCapabilities = { oneShot: true, continuable: true, outputSchema: false, toolFilter: true };
  const start = async (request: { readonly prompt: string; readonly descriptor: import("@code-review-agent/contracts").SubagentDescriptor }, context: ProviderRunContext): Promise<ProviderRun> => {
    const registry = childRegistry(options.baseToolDefinitions, request.descriptor.toolAllowlist, request.descriptor.mcpAllowlist);
    const host = new AgentHost({
      store: options.store,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(registry === undefined ? {} : { toolRegistry: registry }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      permissionPreset: request.descriptor.permissionPreset,
      ...(options.subagentRuntime === undefined ? {} : { subagentRuntime: options.subagentRuntime }),
    });
    let currentTurn: import("@code-review-agent/contracts").TurnId | undefined;
    let disposed = false;
    const runTurn = async (prompt: string, signal: AbortSignal): Promise<TaskReport> => {
      if (disposed) throw new Error("SUBAGENT_DISPOSED");
      currentTurn = await host.sendMessage(context.childSessionId, prompt);
      const cancel = () => { if (currentTurn !== undefined) void host.cancelTurn(context.childSessionId, currentTurn).catch(() => undefined); };
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
      try {
        await host.waitForTurn(currentTurn, 120_000);
        const projection = await host.getSession(context.childSessionId);
        const turn = projection?.turns.find((candidate) => candidate.id === currentTurn);
        const summary = turn?.assistantMessage?.trim() || "Child completed without assistant text";
        const status = turn?.status === "completed" ? "completed" : turn?.status === "interrupted" || signal.aborted ? "cancelled" : "failed";
        return { taskId: context.taskId, childSessionId: context.childSessionId, status, stopReason: status === "completed" ? "completed" : signal.aborted ? "aborted" : "error", summary, output: summary, artifacts: [] };
      } finally {
        signal.removeEventListener("abort", cancel);
        currentTurn = undefined;
      }
    };
    return {
      result: () => runTurn(request.prompt, context.signal),
      sendMessage: (prompt, signal) => runTurn(prompt, signal),
      interrupt: async () => { if (currentTurn !== undefined) await host.cancelTurn(context.childSessionId, currentTurn); },
      dispose: async () => { disposed = true; if (currentTurn !== undefined) await host.cancelTurn(context.childSessionId, currentTurn).catch(() => undefined); },
    };
  };
  return { name: "in-process", capabilities, start, resume: async (descriptor, context) => start({ prompt: "Resume the child from its durable inbox.", descriptor }, context) };
}
