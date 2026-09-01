/** Phase 8.0 responsive visual baseline gate. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const baselineRoot = join(root, "docs", "archive", "phases", "phase8-visual-baselines");
const manifest = JSON.parse(await readFile(join(baselineRoot, "manifest.json"), "utf8"));
const shellMarkup = await readFile(join(root, "apps", "web", "index.html"), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8 visual gate: ${message}`); };

assert(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
assert(manifest.source === "phase8-web-fixture", "manifest source must identify the real Web fixture");
assert(manifest.settingsCapabilityState?.plugins === "deferred", "Settings manifest must record Plugins as deferred");
assert(typeof manifest.settingsCapabilityState?.pluginsReason === "string" && manifest.settingsCapabilityState.pluginsReason.length > 0, "Settings manifest must explain the deferred Plugins state");
assert(Array.isArray(manifest.baselines) && manifest.baselines.length === 6, "manifest must contain six responsive baselines");
const sidebarMatrix = manifest.sidebarMatrix;
assert(sidebarMatrix?.schemaVersion === 1, "sidebar matrix schemaVersion must be 1");
assert(JSON.stringify(sidebarMatrix.viewportWidths) === JSON.stringify([600, 900, 1024]), "sidebar matrix must cover 600/900/1024 widths");
assert(JSON.stringify(sidebarMatrix.states) === JSON.stringify(["empty", "long-list", "search", "workspace-menu", "attention"]), "sidebar matrix states are incomplete or reordered");
assert(sidebarMatrix.evidence === "stable-shell-assertions", "sidebar matrix must identify stable shell assertions as evidence");
for (const assertion of ["listScrollport", "searchCollapsed", "attentionHiddenWhenEmpty", "attentionRoutesToDetails", "workspaceMenuOnFocus"]) {
  assert(sidebarMatrix.assertions?.[assertion] === true, `sidebar matrix assertion ${assertion} is missing`);
}
assert(sidebarMatrix.assertions?.defaultSessionWindow === 5, "sidebar matrix default session window must be five rows");
assert(shellMarkup.includes('class="sidebar-list-scroll" role="region" aria-label="Workspace and session list" tabindex="0"'), "sidebar visual gate is missing the dedicated list scrollport");
assert(shellMarkup.includes('id="session-search-toggle"') && shellMarkup.includes('aria-expanded="false"'), "sidebar visual gate is missing collapsed search state");
assert(shellMarkup.includes('id="sidebar-attention"') && shellMarkup.includes('id="sidebar-attention-button"'), "sidebar visual gate is missing attention indicator");
assert(shellMarkup.includes("sessions.slice(0, limit)") && shellMarkup.includes("className = 'workspace-show-more'"), "sidebar visual gate is missing long-list overflow state");
assert(shellMarkup.includes("Workspace actions · ${label}") && shellMarkup.includes("Session actions · ${label}"), "sidebar visual gate is missing focus/hover menu affordances");

const expected = new Map([
  ["shell:600x800", "web-shell-600x800.jpg"],
  ["settings:600x800", "web-settings-600x800.jpg"],
  ["shell:900x800", "web-shell-900x800.jpg"],
  ["settings:900x800", "web-settings-900x800.jpg"],
  ["shell:1024x800", "web-shell-1024x800.jpg"],
  ["settings:1024x800", "web-settings-1024x800.jpg"],
]);

function inspectImage(bytes, file) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`${file} is not a PNG or JPEG image`);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`${file} has an invalid JPEG marker boundary`);
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error(`${file} has a truncated JPEG segment`);
    const isSof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
    if (isSof && length >= 7) return { format: "jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    offset += length;
  }
  throw new Error(`${file} does not contain a JPEG frame header`);
}

const results = [];
for (const entry of manifest.baselines) {
  const key = `${entry.surface}:${entry.width}x${entry.height}`;
  assert(expected.get(key) === entry.file, `manifest entry mismatch for ${key}`);
  const file = join(baselineRoot, entry.file);
  const info = inspectImage(await readFile(file), entry.file);
  assert(info.width === entry.width && info.height === entry.height, `${entry.file} is ${info.width}x${info.height}, expected ${entry.width}x${entry.height}`);
  results.push({ file: entry.file, surface: entry.surface, format: info.format, width: info.width, height: info.height });
}

const settings = results.filter((entry) => entry.surface === "settings");
const shell = results.filter((entry) => entry.surface === "shell");
assert(settings.length === 3 && shell.length === 3, "must have three shell and three settings baselines");
for (const entry of settings) {
  assert(entry.file !== shell.find((candidate) => candidate.width === entry.width)?.file, `Settings and shell baselines must be separate files at ${entry.width}px`);
}

console.log(JSON.stringify({ phase: "8.0", gate: "responsive-visual-baselines", passed: true, baselines: results, sidebarMatrix: { widths: sidebarMatrix.viewportWidths, states: sidebarMatrix.states, evidence: sidebarMatrix.evidence }, plugins: manifest.settingsCapabilityState.plugins }));
