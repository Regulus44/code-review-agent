import { describe, expect, it } from "vitest";
import { brand, type ChatModel, type ModelRequest, type ModelStreamPart } from "@coding-agent/contracts";
import { InMemoryEventStore } from "@coding-agent/storage";
import { SkillRegistry } from "@coding-agent/skills";
import { AgentHost } from "./index.js";

describe("M7 Skill resource multi-step acceptance", () => {
  it("lets the model invoke SkillTool, then explicitly read a reference and script window", async () => {
    const store = new InMemoryEventStore();
    const skills = new SkillRegistry();
    let resourceReads = 0;
    skills.registerProvider({
      name: "m7-fixture",
      list: async () => [{ name: "review", description: "review", source: "local", provider: "m7-fixture", trust: "local", invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: "review", resourceBase: { kind: "opaque", description: "fixture" } }],
      get: async (candidate) => ({ ...candidate, content: "Read references/checklist.md and scripts/check.ts only when needed." }),
      readResource: async (_candidate, request) => {
        resourceReads += 1;
        if (request.path === "references/checklist.md") return { ok: true, resource: { path: request.path, content: "checklist item", sizeBytes: 14, mediaType: "text/plain" } };
        return { ok: true, resource: { path: request.path, content: "line 201", sizeBytes: 512, truncated: true, mediaType: "text/plain" } };
      },
    });
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          yield { type: "tool_call_start", index: 0, id: "m7-skill", name: "skill" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "review" }) };
          yield { type: "tool_call_end", index: 0 };
        } else if (toolMessages.length === 1) {
          const skillView = toolMessages[0]?.content ?? "";
          if (!skillView.includes("read_skill_resource")) throw new Error("Skill resource hint was not visible to the model");
          yield { type: "tool_call_start", index: 0, id: "m7-reference", name: "read_skill_resource" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "review", path: "references/checklist.md" }) };
          yield { type: "tool_call_end", index: 0 };
        } else if (toolMessages.length === 2) {
          if (!toolMessages.some((message) => message.content.includes("checklist item"))) throw new Error("Reference body was not visible in the next model step");
          yield { type: "tool_call_start", index: 0, id: "m7-script", name: "read_skill_resource" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "review", path: "scripts/check.ts", offset: 200, limit: 64 }) };
          yield { type: "tool_call_end", index: 0 };
        } else {
          if (!toolMessages.some((message) => message.content.includes("line 201"))) throw new Error("Script window was not visible in the next model step");
          yield { type: "text_delta", text: "review complete" };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, skills, skillToolEnabled: true, skillResourceToolEnabled: true });
    const session = await host.createSession(brand<string, "WorkspaceRoot">("D:/m7-runtime"));
    const turn = await host.sendMessage(session.id, "review this change");
    await host.waitForTurn(turn);
    expect(resourceReads).toBe(2);
    expect(requests).toHaveLength(4);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("checklist item"))).toBe(false);
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("review complete");
    const events = await host.events(session.id);
    expect(JSON.stringify(events)).not.toContain("checklist item");
    expect(JSON.stringify(events)).not.toContain("line 201");
  });
});
