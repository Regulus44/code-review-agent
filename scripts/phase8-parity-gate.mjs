/** Phase 8.0 aggregate Web parity contract gate. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const shell = await readFile(join(root, "apps", "web", "index.html"), "utf8");
const browser = await readFile(join(root, "apps", "web", "dist", "browser.js"), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8 parity gate: ${message}`); };

const shellMarkers = [
  "Current goal", "Plan", "Questions", "Workspace view", "Workspace sort", "Search sessions",
  "Cancel job", "Retry job", "LSP diagnostics & source locations", "Workspace settings",
  "Catalog status", "Retry model catalog", "Produced files & artifacts", "Tasks & child agents",
];
for (const marker of shellMarkers) assert(shell.includes(marker), `Web shell is missing ${marker}`);

const browserSymbols = [
  "presentGoalBar", "presentPlan", "presentTodoPanel", "presentQuestionBatch", "presentLspTool",
  "presentRuntimeDiagnostics", "presentSettings", "buildNavigationModel", "queryTrajectory", "inspectTrajectory",
];
for (const symbol of browserSymbols) assert(browser.includes(symbol), `browser bundle is missing ${symbol}`);

for (const marker of ["@media (max-width: 900px)", "@media (max-width: 600px)", "aria-live"]) {
  assert(shell.includes(marker), `responsive/accessibility baseline is missing ${marker}`);
}
assert(browser.includes("createFocusTrap"), "browser bundle is missing keyboard focus trapping");

console.log(JSON.stringify({ phase: "8.0", gate: "aggregate-web-parity-contract", passed: true, shellMarkers: shellMarkers.length, browserSymbols: browserSymbols.length }));
