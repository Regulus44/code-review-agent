import { assert, collectSse, withFixture } from "./fixture.mjs";

/**
 * M7 sidebar attention acceptance boundary.
 *
 * This scenario deliberately stays on the real SQLite/API/SSE path consumed
 * by the Web shell. It does not fake DOM state: pending request counts come
 * from the recovered Session projection and MCP failure comes from the MCP
 * API lifecycle. Graphical focus/ARIA assertions live in the shell contract
 * tests and the M7 gate's navigation matrix.
 */
export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    let projection = await fixture.session(created.id);

    const requests = collectSse(`${fixture.baseUrl}/v1/sessions/${created.id}/events?after_sequence=${projection.lastSequence}`, 2);
    await requests.ready;
    await fixture.append(created.id, "interaction/requested", {
      interactionId: "m7-interaction",
      toolCallId: "m7-tool-question",
      question: "Which sidebar state should be shown?",
      options: [{ label: "Attention", value: "attention" }],
      allowFreeform: false,
    }, "m7-turn");
    await fixture.append(created.id, "permission/requested", {
      permissionId: "m7-permission",
      toolCallId: "m7-tool-write",
      toolName: "write_file",
      riskLevel: "write",
      reason: "M7 fixture permission",
      caller: "agent",
      workspaceRoot: created.workspaceRoot,
    }, "m7-turn");
    const liveRequestEvents = await requests.result;
    assert(liveRequestEvents.map((item) => item.event.type).join(",") === "interaction/requested,permission/requested", "SSE did not deliver pending attention events in order");

    projection = await fixture.session(created.id);
    assert(projection.interactions?.some((item) => item.id === "m7-interaction" && item.status === "pending"), "pending interaction did not enter the durable projection");
    assert(projection.permissions?.some((item) => item.id === "m7-permission" && item.status === "pending"), "pending permission did not enter the durable projection");

    await fixture.restart();
    const recovered = await fixture.session(created.id);
    assert(recovered.interactions?.some((item) => item.id === "m7-interaction" && item.status === "pending"), "pending interaction was not restored after restart");
    assert(recovered.permissions?.some((item) => item.id === "m7-permission" && item.status === "pending"), "pending permission was not restored after restart");

    const resolutions = collectSse(`${fixture.baseUrl}/v1/sessions/${created.id}/events?after_sequence=${recovered.lastSequence}`, 2);
    await resolutions.ready;
    await fixture.append(created.id, "interaction/resolved", {
      interactionId: "m7-interaction",
      toolCallId: "m7-tool-question",
      question: "Which sidebar state should be shown?",
      status: "answered",
      answer: "attention",
    }, "m7-turn");
    await fixture.append(created.id, "permission/resolved", {
      permissionId: "m7-permission",
      toolCallId: "m7-tool-write",
      status: "approved",
    }, "m7-turn");
    const resolvedEvents = await resolutions.result;
    assert(resolvedEvents.map((item) => item.event.type).join(",") === "interaction/resolved,permission/resolved", "SSE did not deliver resolved attention events in order");

    const settled = await fixture.session(created.id);
    assert(settled.interactions?.every((item) => item.status !== "pending"), "resolved interaction remained pending");
    assert(settled.permissions?.every((item) => item.status !== "pending"), "resolved permission remained pending");

    const mcpCreatedResponse = await fixture.request("/v1/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "m7-broken-server",
        scope: "project",
        workspaceRoot: created.workspaceRoot,
        transport: "stdio",
        command: "m7-command-that-does-not-exist",
        enabled: true,
        start: true,
        failOnStartupError: false,
        reconnect: { enabled: false },
      }),
    }, 201);
    const mcpCreated = mcpCreatedResponse.body;
    assert(typeof mcpCreated?.status === "string", `MCP failure fixture did not return a lifecycle state: ${JSON.stringify(mcpCreatedResponse)}`);
    const failedMcp = await fixture.waitFor("MCP failure", async () => (await fixture.request("/v1/mcp/servers")).body.servers, (servers) => servers.some((server) => server.config?.name === "m7-broken-server" && server.status === "failed"));
    assert(failedMcp.some((server) => server.config?.name === "m7-broken-server" && server.status === "failed"), "MCP failure was not observable through the real API");

    await fixture.restart();
    const replayed = await fixture.session(created.id);
    assert(replayed.interactions?.every((item) => item.status !== "pending") && replayed.permissions?.every((item) => item.status !== "pending"), "resolved attention state changed after replay");
    const failedAfterRestart = await fixture.waitFor("MCP failure after restart", async () => (await fixture.request("/v1/mcp/servers")).body.servers, (servers) => servers.some((server) => server.config?.name === "m7-broken-server" && server.status === "failed"));
    assert(failedAfterRestart.some((server) => server.config?.name === "m7-broken-server" && server.status === "failed"), "MCP failed state was not restored after API restart");

    return {
      sessionId: created.id,
      requestSequences: liveRequestEvents.map((item) => item.event.sequence),
      resolutionSequences: resolvedEvents.map((item) => item.event.sequence),
      pendingAfterRestart: recovered.interactions.filter((item) => item.status === "pending").length + recovered.permissions.filter((item) => item.status === "pending").length,
      pendingAfterResolution: replayed.interactions.filter((item) => item.status === "pending").length + replayed.permissions.filter((item) => item.status === "pending").length,
      mcpStatus: failedAfterRestart.find((server) => server.config?.name === "m7-broken-server")?.status,
    };
  });
}
