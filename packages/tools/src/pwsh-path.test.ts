import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidatePwshPaths, resolvePwshPath } from "./pwsh-path.js";

describe("PowerShell executable resolution", () => {
  it("returns Windows candidates in DSH order and ignores non-Windows hosts", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
      PATH: "\"C:\\Store\"; C:\\Custom ;",
    };
    expect(candidatePwshPaths(env, "win32")).toEqual([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Store\\pwsh.exe",
      "C:\\Custom\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
    expect(candidatePwshPaths(env, "linux")).toEqual([]);
  });

  it("trusts an explicit path and uses bare pwsh when no platform candidate exists", () => {
    expect(resolvePwshPath("C:\\Tools\\pwsh.exe", {}, "win32")).toBe("C:\\Tools\\pwsh.exe");
    expect(resolvePwshPath(undefined, { CODE_REVIEW_AGENT_PWSH: "C:\\Env\\pwsh.exe" }, "win32")).toBe("C:\\Env\\pwsh.exe");
    expect(resolvePwshPath(undefined, { ProgramFiles: "C:\\missing", SystemRoot: "C:\\missing", PATH: "" }, "win32")).toBe("pwsh");
    expect(resolvePwshPath(undefined, {}, "linux")).toBe("pwsh");
  });

  it("selects an existing PowerShell 7 install before PATH entries on Windows", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "cra-pwsh-path-"));
    try {
      const executable = path.win32.join(root, "PowerShell", "7", "pwsh.exe");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "fixture", "utf8");
      const resolved = resolvePwshPath(undefined, { ProgramFiles: root, SystemRoot: path.win32.join(root, "Windows"), PATH: "" }, "win32");
      expect(resolved).toBe(executable);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
