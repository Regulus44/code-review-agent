import { describe, expect, it } from "vitest";
import { ApiError, WebApiClient } from "./api.js";

describe("WebApiClient", () => {
  it("builds typed requests and preserves idempotency headers", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317/",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ turnId: "turn_1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await client.sendMessage("ses_1" as never, "hello", "cmd_1");

    expect(calls[0]?.url).toBe("http://localhost:4317/v1/sessions/ses_1");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("cmd_1");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ content: "hello" }));
  });

  it("builds the host-backed session rename command", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: "ses_rename", title: "Renamed" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.renameSession("ses/rename" as never, "Renamed", "rename_1");
    expect(calls[0]?.url).toBe("http://localhost:4317/v1/sessions/ses%2Frename/title");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("rename_1");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ title: "Renamed" }));
  });

  it("builds the host-backed queue reorder command", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ reordered: true, queuedTurnIds: ["turn_3", "turn_2"] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.reorderQueue("ses_queue" as never, "turn_3" as never, 0, "queue_1");
    expect(calls[0]?.url).toBe("http://localhost:4317/v1/sessions/ses_queue/queue");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("queue_1");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ turnId: "turn_3", position: 0 }));
  });

  it("builds typed workspace catalog and reorder commands", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.listWorkspaces();
    await client.reorderWorkspaces(["d:/first", "d:/second"], "workspace_1");
    expect(calls[0]?.url).toBe("http://localhost:4317/v1/workspaces");
    expect(calls[1]?.url).toBe("http://localhost:4317/v1/workspaces/reorder");
    expect(new Headers(calls[1]?.init?.headers).get("idempotency-key")).toBe("workspace_1");
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ order: ["d:/first", "d:/second"] }));
  });

  it("builds workspace lifecycle commands with encoded keys and idempotency", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.renameWorkspace("D:/repo with space" as never, "Review", "workspace_rename_1");
    await client.archiveWorkspace("D:/repo with space" as never, true, "workspace_archive_1");
    await client.deleteWorkspace("D:/repo with space" as never, "workspace_delete_1");
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:4317/v1/workspaces/D%3A%2Frepo%20with%20space/label",
      "http://localhost:4317/v1/workspaces/D%3A%2Frepo%20with%20space/archive",
      "http://localhost:4317/v1/workspaces/D%3A%2Frepo%20with%20space",
    ]);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ label: "Review" }));
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ archived: true }));
    expect(new Headers(calls[2]?.init?.headers).get("idempotency-key")).toBe("workspace_delete_1");
  });

  it("builds the host-backed steer command", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ accepted: true, turnId: "turn_running", receiptId: "steer_1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.steerTurn("ses_steer" as never, "turn_running" as never, "focus on tests", "steer_cmd_1");
    expect(calls[0]?.url).toBe("http://localhost:4317/v1/sessions/ses_steer/turns/turn_running/steer");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("steer_cmd_1");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ content: "focus on tests" }));
  });

  it("builds capability and attachment upload commands", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ attachments: { enabled: true, maxBytes: 524288, allowedMediaTypes: ["text/plain"], imagesEnabled: false } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.listCapabilities();
    await client.uploadAttachment("ses_attach" as never, { fileName: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=" }, "attach_cmd_1");
    expect(calls[0]?.url).toBe("http://localhost:4317/v1/capabilities");
    expect(calls[1]?.url).toBe("http://localhost:4317/v1/sessions/ses_attach/attachments");
    expect(new Headers(calls[1]?.init?.headers).get("idempotency-key")).toBe("attach_cmd_1");
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ fileName: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=" }));
  });

  it("normalizes non-2xx JSON responses as ApiError", async () => {
    const client = new WebApiClient({
      fetcher: async () => new Response(JSON.stringify({ error: "permission denied" }), { status: 403, headers: { "content-type": "application/json" } }),
    });

    await expect(client.health()).rejects.toMatchObject({ status: 403, message: "permission denied" });
    try {
      await client.health();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).body).toEqual({ error: "permission denied" });
    }
  });

  it("builds replay URLs from the last sequence", () => {
    const client = new WebApiClient({ baseUrl: "http://localhost:4317" });
    expect(client.eventsUrl("ses/with space" as never, 12)).toBe("http://localhost:4317/v1/sessions/ses%2Fwith%20space/events?after_sequence=12");
    expect(client.artifactContentUrl("ses/with space" as never, "artifact/file", true)).toBe("http://localhost:4317/v1/sessions/ses%2Fwith%20space/artifacts/artifact%2Ffile/content?download=true");
  });

  it("builds bounded history page queries and normalizes the page envelope", async () => {
    const calls: string[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ events: [], hasMoreBefore: true, hasMoreAfter: false, oldestSequence: 8, newestSequence: 9 }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const page = await client.listEventsPage("ses_page" as never, { beforeSequence: 10, limit: 2 });
    expect(calls[0]).toContain("before_sequence=10");
    expect(calls[0]).toContain("limit=2");
    expect(page).toMatchObject({ hasMoreBefore: true, oldestSequence: 8, newestSequence: 9 });
  });

  it("builds typed worktree lifecycle commands", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: "ses_worktree", worktrees: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.listWorktrees("ses/worktree" as never);
    await client.createWorktree("ses/worktree" as never, { branch: "feature/api" }, "wt-create");
    await client.attachWorktree("ses/worktree" as never, "wt_1", "wt-attach");
    await client.switchWorktree("ses/worktree" as never, "wt_1", "wt-switch");
    await client.cleanupWorktree("ses/worktree" as never, "wt_1", true, "wt-clean");
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:4317/v1/sessions/ses%2Fworktree/worktrees",
      "http://localhost:4317/v1/sessions/ses%2Fworktree/worktrees",
      "http://localhost:4317/v1/sessions/ses%2Fworktree/worktrees/wt_1/attach",
      "http://localhost:4317/v1/sessions/ses%2Fworktree/worktrees/wt_1/switch",
      "http://localhost:4317/v1/sessions/ses%2Fworktree/worktrees/wt_1/cleanup",
    ]);
    expect(new Headers(calls[4]?.init?.headers).get("idempotency-key")).toBe("wt-clean");
    expect(calls[4]?.init?.body).toBe(JSON.stringify({ force: true }));
  });
});
