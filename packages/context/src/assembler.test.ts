import { describe, expect, it } from "vitest";
import { assembleContext, type SystemPromptSection } from "./assembler.js";

const sections: readonly SystemPromptSection[] = [
  { id: "dynamic", phase: "dynamic", order: 10, content: "dynamic" },
  { id: "static", phase: "static", order: 20, content: "static" },
];

const tools = [
  { name: "z_tool", description: "z", parameters: { type: "object" as const } },
  { name: "a_tool", description: "a", parameters: { type: "object" as const } },
];

describe("M03 context assembly", () => {
  it("keeps static sections before dynamic sections and preserves model order", () => {
    const assembly = assembleContext({
      systemSections: sections,
      visibleTools: tools,
      history: [{ role: "user", content: "request" }],
    });
    expect(assembly.sections.map((section) => section.id)).toEqual(["static", "dynamic"]);
    expect(assembly.systemPrompt).toBe("static\n\ndynamic");
    expect(assembly.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(assembly.visibleTools.map((tool) => tool.name)).toEqual(["a_tool", "z_tool"]);
  });

  it("produces a stable fingerprint for equivalent input regardless of section/tool input order", () => {
    const first = assembleContext({ systemSections: sections, visibleTools: tools, history: [{ role: "user", content: "request" }] });
    const second = assembleContext({ systemSections: [...sections].reverse(), visibleTools: [...tools].reverse(), history: [{ role: "user", content: "request" }] });
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("sorts attachments, marks them as untrusted data, and appends them after history", () => {
    const assembly = assembleContext({
      systemSections: [],
      visibleTools: [],
      history: [{ role: "user", content: "request" }],
      attachments: [
        { id: "b", kind: "file", order: 2, content: "second" },
        { id: "a", kind: "file", order: 1, content: "first" },
      ],
    });
    expect(assembly.attachments.map((attachment) => attachment.id)).toEqual(["a", "b"]);
    expect(assembly.messages.map((message) => message.role)).toEqual(["system", "user", "user", "user"]);
    expect(assembly.messages[2]?.content).toContain("untrusted context data");
    expect(assembly.messages[2]?.content).toContain("first");
  });

  it("rejects duplicate and malformed identifiers", () => {
    expect(() => assembleContext({
      systemSections: [
        { id: "same", phase: "static", order: 1, content: "one" },
        { id: "same", phase: "dynamic", order: 2, content: "two" },
      ],
      visibleTools: [],
      history: [],
    })).toThrow("CONTEXT_SECTION_DUPLICATE");
    expect(() => assembleContext({
      systemSections: [],
      visibleTools: [],
      history: [],
      attachments: [{ id: "bad", kind: "file", order: 1.5, content: "x" }],
    })).toThrow("CONTEXT_ATTACHMENT_ORDER_INVALID");
  });
});
