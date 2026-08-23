/**
 * Phase 8.0 Web parity gate for the durable planning/question vertical slice.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(process.execPath, [join(root, "scripts", "phase8-web-fixture-server.mjs")], {
  cwd: root,
  env: { ...process.env, PHASE8_WEB_ROOT: join(root, "apps", "web") },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const fixture = await new Promise((resolve, reject) => {
  const readline = createInterface({ input: child.stdout });
  const onExit = (code, signal) => reject(new Error(`Phase 8 Web fixture exited (${code ?? signal}): ${stderr}`));
  child.once("exit", onExit);
  readline.once("line", (value) => {
    child.removeListener("exit", onExit);
    readline.close();
    try { resolve(JSON.parse(value)); } catch (error) { reject(error); }
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8 Web gate: ${message}`);
}

async function request(pathname, init = {}, expected = 200) {
  const response = await fetch(`${fixture.baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return body;
}

try {
  const health = await request("/health");
  assert(health.runtime === "typescript" && health.persistence === "sqlite", "fixture is not the durable TypeScript runtime");
  const shell = await request("/");
  assert(typeof shell === "string" && shell.includes("/web/browser.js"), "Web shell does not use the typed bridge");
  const browserAsset = await request("/web/browser.js");
  for (const symbol of ["presentGoalBar", "presentPlan", "presentTodoPanel", "presentQuestionBatch"]) {
    assert(typeof browserAsset === "string" && browserAsset.includes(symbol), `browser bundle is missing ${symbol}`);
  }

  let projection = await request(`/v1/sessions/${fixture.sessionId}`);
  assert(projection.goals?.some((goal) => goal.id === fixture.goalId && goal.status === "active"), "active Goal did not replay");
  assert(projection.plan?.status === "draft" && projection.plan.content.includes("browser gate"), "draft Plan did not replay");
  assert(projection.todos?.length === 2 && projection.todos[0].status === "in_progress", "Todo panel data did not replay");
  assert(projection.interactions?.filter((item) => item.turnId === fixture.turnId).length === 2, "Question batch did not replay as two same-turn interactions");

  const first = fixture.interactions.first;
  const second = fixture.interactions.second;
  const answerHeaders = { "content-type": "application/json", "idempotency-key": "phase8-web-answer-1" };
  const answered = await request(`/v1/sessions/${fixture.sessionId}/interactions/${first}`, {
    method: "POST", headers: answerHeaders, body: JSON.stringify({ status: "answered", answer: "stable" }),
  });
  assert(answered.status === "answered" && answered.answer === "stable", "first question was not answered");
  const repeatedAnswer = await request(`/v1/sessions/${fixture.sessionId}/interactions/${first}`, {
    method: "POST", headers: answerHeaders, body: JSON.stringify({ status: "answered", answer: "stable" }),
  });
  assert(JSON.stringify(repeatedAnswer) === JSON.stringify(answered), "repeated question answer was not idempotent");
  const cancelled = await request(`/v1/sessions/${fixture.sessionId}/interactions/${second}`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-web-question-cancel" }, body: JSON.stringify({ status: "cancelled" }),
  });
  assert(cancelled.status === "cancelled", "second question was not cancellable");

  projection = await request(`/v1/sessions/${fixture.sessionId}`);
  const planSequence = projection.plan.lastSequence;
  const planHeaders = { "content-type": "application/json", "idempotency-key": "phase8-web-plan-approve" };
  const approved = await request(`/v1/sessions/${fixture.sessionId}/plan`, {
    method: "POST", headers: planHeaders, body: JSON.stringify({ content: projection.plan.content, status: "approved", expectedSequence: planSequence }),
  });
  assert(approved.plan.status === "approved", "Plan review did not approve the durable plan");
  const repeatedPlan = await request(`/v1/sessions/${fixture.sessionId}/plan`, {
    method: "POST", headers: planHeaders, body: JSON.stringify({ content: projection.plan.content, status: "approved", expectedSequence: planSequence }),
  });
  assert(repeatedPlan.plan.status === "approved" && repeatedPlan.plan.lastSequence === approved.plan.lastSequence, "repeated Plan review was not idempotent");

  projection = await request(`/v1/sessions/${fixture.sessionId}`);
  const goal = projection.goals.find((item) => item.id === fixture.goalId);
  const paused = await request(`/v1/sessions/${fixture.sessionId}/goals/${fixture.goalId}`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-web-goal-pause" }, body: JSON.stringify({ status: "paused", expectedSequence: goal.lastSequence }),
  });
  assert(paused.goals.find((item) => item.id === fixture.goalId)?.status === "paused", "Goal pause did not persist");
  await request(`/v1/sessions/${fixture.sessionId}/goals/${fixture.goalId}`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-web-goal-stale" }, body: JSON.stringify({ status: "active", expectedSequence: goal.lastSequence }),
  }, 409);

  projection = await request(`/v1/sessions/${fixture.sessionId}`);
  const todos = projection.todos.map((item) => ({ ...item, status: item.id === "confirm-scope" ? "completed" : "in_progress" }));
  const todoHeaders = { "content-type": "application/json", "idempotency-key": "phase8-web-todo-update" };
  const updatedTodos = await request(`/v1/sessions/${fixture.sessionId}/todos`, {
    method: "POST", headers: todoHeaders, body: JSON.stringify({ todos, expectedSequence: projection.lastSequence }),
  });
  assert(updatedTodos.todos.find((item) => item.id === "confirm-scope")?.status === "completed", "Todo update did not persist");
  const repeatedTodos = await request(`/v1/sessions/${fixture.sessionId}/todos`, {
    method: "POST", headers: todoHeaders, body: JSON.stringify({ todos, expectedSequence: projection.lastSequence }),
  });
  assert(repeatedTodos.lastSequence === updatedTodos.lastSequence, "repeated Todo update was not idempotent");

  const events = await request(`/v1/sessions/${fixture.sessionId}/events?format=json`);
  const types = new Set(events.map((event) => event.type));
  for (const type of ["goal/created", "goal/updated", "plan/updated", "todo/updated", "interaction/requested", "interaction/resolved"]) {
    assert(types.has(type), `replay is missing ${type}`);
  }
  console.log(JSON.stringify({ phase: "8.0", gate: "web-planning-question-replay", passed: true, events: events.length, questions: 2 }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
