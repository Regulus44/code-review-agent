import { lstatSync } from "node:fs";
import path from "node:path";

/**
 * Return the Windows PowerShell executable candidates in the same order used
 * by the DSH local PowerShell executor. This function only derives paths from
 * its inputs; filesystem probing is kept in resolvePwshPath().
 */
export function candidatePwshPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [];

  const join = path.win32.join;
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];

  // PATH entries may contain surrounding quotes when supplied by setx-style
  // configuration. Windows PATH uses semicolons regardless of host shell.
  for (const entry of (env.PATH ?? env.Path ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (trimmed.length > 0) candidates.push(join(trimmed, "pwsh.exe"));
  }

  // Windows PowerShell 5.1 is the last explicit candidate on legacy hosts.
  candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  return candidates;
}

function candidateExists(candidate: string): boolean {
  try {
    const info = lstatSync(candidate);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve the executable used by the pwsh tool. An explicit configured path
 * is trusted as-is; otherwise Windows well-known locations are probed and all
 * other platforms use PATH resolution through the bare `pwsh` name.
 */
export function resolvePwshPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  if (platform === "win32") {
    const environmentPath = env.CODE_REVIEW_AGENT_PWSH;
    if (environmentPath !== undefined && environmentPath.length > 0) return environmentPath;
  }
  for (const candidate of candidatePwshPaths(env, platform)) {
    if (candidateExists(candidate)) return candidate;
  }
  return "pwsh";
}
