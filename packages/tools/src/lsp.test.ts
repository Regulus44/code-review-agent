import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { LspManager } from "./lsp.js";

const fixture = fileURLToPath(new URL("../test-fixtures/lsp-server.mjs", import.meta.url));

describe("LspManager", () => {
  it("emits lifecycle/request events and reuses a workspace-scoped transport", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-lsp-"));
    try {
      await writeFile(path.join(root, "fixture.ts"), "const value = 1;\n", "utf8");
      const events: { type: string; payload: Readonly<Record<string, unknown>> }[] = [];
      const manager = new LspManager({ default: { command: process.execPath, args: [fixture], languageIds: { ".ts": "typescript" } } });
      const hooks = { sessionId: "ses_lsp", toolCallId: "call_lsp", appendEvent: async (type: "lsp/server" | "lsp/request", payload: Readonly<Record<string, unknown>>) => { events.push({ type, payload }); } };
      try {
        const diagnostics = await manager.diagnostics({ path: "fixture.ts" }, root, new AbortController().signal, hooks);
        expect(diagnostics).toMatchObject({ ok: true, output: { result: { items: [{ message: "fixture diagnostic" }] } } });
        const definition = await manager.definition({ path: "fixture.ts", line: 0, character: 6 }, root, new AbortController().signal, hooks);
        expect(definition).toMatchObject({ ok: true, output: { result: [{ uri: "file:///fixture.ts" }] } });
        expect(events.filter((event) => event.type === "lsp/server").map((event) => event.payload["action"])).toEqual(expect.arrayContaining(["started", "initialized"]));
        expect(events.filter((event) => event.type === "lsp/request").map((event) => event.payload["action"])).toEqual(expect.arrayContaining(["started", "completed"]));
        expect(events.filter((event) => event.type === "lsp/server" && event.payload["action"] === "started")).toHaveLength(1);
      } finally { await manager.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("replaces a crashed server transport and retries the read-only request once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-lsp-restart-"));
    try {
      await writeFile(path.join(root, "fixture.ts"), "const value = 1;\n", "utf8");
      const marker = path.join(root, "crashed.marker");
      const events: { type: string; payload: Readonly<Record<string, unknown>> }[] = [];
      const manager = new LspManager({ default: { command: process.execPath, args: [fixture, marker, "crash-once"], requestTimeoutMs: 1_000 } });
      try {
        const result = await manager.diagnostics({ path: "fixture.ts" }, root, new AbortController().signal, { appendEvent: async (type, payload) => { events.push({ type, payload }); } });
        expect(result).toMatchObject({ ok: true, output: { result: { items: [{ message: "fixture diagnostic" }] } } });
        expect(events.some((event) => event.type === "lsp/server" && event.payload["action"] === "crashed")).toBe(true);
        expect(events.some((event) => event.type === "lsp/server" && event.payload["action"] === "restart_requested")).toBe(true);
      } finally { await manager.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("sends cancellation, bounds documents, and does not wait for a slow server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-lsp-cancel-"));
    try {
      await writeFile(path.join(root, "fixture.ts"), "const value = 1;\n", "utf8");
      const manager = new LspManager({ default: { command: process.execPath, args: [fixture, "", "slow"], requestTimeoutMs: 2_000, maxDocumentBytes: 100 } });
      const controller = new AbortController();
      try {
        const pending = manager.diagnostics({ path: "fixture.ts" }, root, controller.signal);
        setTimeout(() => controller.abort(), 30).unref();
        await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "LSP_CANCELLED" } });
        const bounded = new LspManager({ default: { command: process.execPath, args: [fixture], maxDocumentBytes: 1 } });
        try { await expect(bounded.diagnostics({ path: "fixture.ts" }, root, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: "LSP_DOCUMENT_TOO_LARGE" } }); } finally { await bounded.close(); }
      } finally { await manager.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
