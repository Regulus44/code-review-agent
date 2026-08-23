import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "apps/web/dist");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [resolve(root, "apps/web/src/browser.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: resolve(outdir, "browser.js"),
  sourcemap: true,
  logLevel: "info",
});
