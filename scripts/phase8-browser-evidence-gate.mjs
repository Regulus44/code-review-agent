/** Phase 8.0 real in-app browser evidence audit. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const evidence = JSON.parse(await readFile(join(root, "docs", "phase8-browser-evidence.json"), "utf8"));
const shell = await readFile(join(root, "apps", "web", "index.html"), "utf8");
const manifest = JSON.parse(await readFile(join(root, "docs", "phase8-visual-baselines", "manifest.json"), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8 browser evidence gate: ${message}`); };

assert(evidence.schemaVersion === 1, "evidence schemaVersion must be 1");
assert(evidence.phase === "8.0", "evidence must belong to Phase 8.0");
assert(evidence.browser === "Codex In-app Browser", "evidence must identify the in-app browser");
assert(evidence.fixture === "scripts/phase8-web-fixture-server.mjs", "evidence must point to the durable Web fixture");
assert(Array.isArray(evidence.matrix) && evidence.matrix.length === 3, "evidence must contain 600/900/1024 viewport rows");

const widths = evidence.matrix.map((row) => row.viewport?.width);
assert(JSON.stringify(widths) === JSON.stringify([600, 900, 1024]), "viewport matrix must be ordered 600, 900, 1024");
for (const row of evidence.matrix) {
  assert(row.viewport?.height === 800, `viewport ${row.viewport?.width} must be 800px high`);
  assert(row.horizontalOverflow === false, `viewport ${row.viewport?.width} reports horizontal overflow`);
  assert(row.settingsDialog?.ariaModal === "true" && row.settingsDialog?.labelledBy === "settings-title", `viewport ${row.viewport?.width} is missing dialog semantics`);
  assert(row.settingsDialog?.escapeCloses === true && row.settingsDialog?.openerFocusRestored === true && row.settingsDialog?.focusRemainsInside === true, `viewport ${row.viewport?.width} is missing keyboard focus evidence`);
  assert(row.aria?.unnamedVisibleControls === 0, `viewport ${row.viewport?.width} has unnamed visible controls`);
}
assert(evidence.matrix[0].mobileSidebar?.open === true && evidence.matrix[0].mobileSidebar?.closed === true, "600px sidebar drawer evidence is incomplete");
assert(evidence.matrix[1].mobileSidebar?.open === true && evidence.matrix[1].mobileSidebar?.closed === true, "900px sidebar drawer evidence is incomplete");
assert(evidence.matrix[2].detailsPanel?.open === true && evidence.matrix[2].detailsPanel?.closed === true && evidence.matrix[2].detailsPanel?.reopened === true, "1024px details panel evidence is incomplete");

assert(evidence.settingsRecovery?.fixtureEnv?.PHASE8_MODEL_FAILURES === 1, "settings recovery evidence must use one bounded provider failure");
assert(evidence.settingsRecovery.failure?.catalogStatus === "error" && evidence.settingsRecovery.failure?.retryAction === "Retry model catalog", "settings failure evidence is incomplete");
assert(evidence.settingsRecovery.recovery?.catalogStatus === "ready" && evidence.settingsRecovery.recovery?.model === "fixture-model", "settings recovery evidence is incomplete");
assert(evidence.settingsRecovery.selection?.receipt === "Selected fixture-model", "selection receipt evidence is missing");

assert(manifest.baselines?.length === 6, "visual manifest must retain six Shell/Settings baselines");
for (const marker of ["role=\"dialog\"", "aria-modal", "aria-labelledby", "createFocusTrap", "Retry model catalog", "settings-receipt"]) {
  assert(shell.includes(marker), `Web shell is missing ${marker}`);
}

console.log(JSON.stringify({ phase: "8.0", gate: "browser-accessibility-evidence", passed: true, viewports: widths, baselines: manifest.baselines.length, settingsRecovery: true }));
