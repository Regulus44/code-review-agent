import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { auditScope } from "./scope-audit.ts";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace);
  const { stdout } = await execFileAsync("git", ["-C", workspace, "-c", "core.longpaths=true", "status", "--porcelain=v1", "--untracked-files=all", "-z"], { windowsHide: true });
  const audit = auditScope({
    statusPorcelain: stdout,
    allowedPaths: args.allowed,
    forbiddenPaths: args.forbidden,
    runtimeArtifactPaths: args.runtimeArtifacts,
  });
  const serialized = `${JSON.stringify({ workspace, ...audit }, null, 2)}\n`;
  if (args.output !== undefined) await writeFile(path.resolve(args.output), serialized, "utf8");
  process.stdout.write(serialized);
}

function parseArgs(argv: readonly string[]): {
  readonly workspace: string;
  readonly allowed?: readonly string[];
  readonly forbidden?: readonly string[];
  readonly runtimeArtifacts?: readonly string[];
  readonly output?: string;
} {
  let workspace: string | undefined;
  let allowed: string[] | undefined;
  let forbidden: string[] | undefined;
  let runtimeArtifacts: string[] | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--workspace" && value !== undefined) { workspace = value; index += 1; }
    else if (flag === "--allowed" && value !== undefined) { allowed = value.split(","); index += 1; }
    else if (flag === "--forbidden" && value !== undefined) { forbidden = value.split(","); index += 1; }
    else if (flag === "--runtime-artifacts" && value !== undefined) { runtimeArtifacts = value.split(","); index += 1; }
    else if (flag === "--output" && value !== undefined) { output = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${flag ?? "<missing>"}`);
  }
  if (workspace === undefined) throw new Error("--workspace is required");
  return { workspace, allowed, forbidden, runtimeArtifacts, output };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
