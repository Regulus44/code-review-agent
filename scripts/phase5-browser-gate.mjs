/**
 * Phase 5 browser/replay acceptance gate.
 *
 * The repository does not pin Playwright as a production dependency. These
 * scenarios therefore exercise the real HTTP, SSE and SQLite boundaries that
 * the browser bundle consumes, while keeping each DSH-mapped behavior in its
 * own file under apps/web/tests for later graphical-browser execution.
 */
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scenarios = [
  "chat-continuous-conversation.e2e.mjs",
  "replay-round-trip.e2e.mjs",
  "lifecycle-chrome.e2e.mjs",
  "queue-reconnect.e2e.mjs",
  "composer-failure.e2e.mjs",
  "chat-scroll-contract.e2e.mjs",
  "trajectory-virtualization.e2e.mjs",
  "stats-paged-history.e2e.mjs",
];

const startedAt = performance.now();
const results = [];
for (const name of scenarios) {
  const module = await import(`../apps/web/tests/${name}`);
  if (typeof module.run !== "function") throw new Error(`${name} does not export run()`);
  const scenarioStarted = performance.now();
  const result = await module.run();
  results.push({ name, elapsedMs: Math.round(performance.now() - scenarioStarted), result });
}

console.log(JSON.stringify({
  phase: "5",
  gate: "browser-replay-boundary",
  passed: true,
  root,
  scenarios: results,
  elapsedMs: Math.round(performance.now() - startedAt),
}));
