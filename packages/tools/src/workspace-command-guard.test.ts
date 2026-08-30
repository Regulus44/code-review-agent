import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectCommand } from "./workspace-command-guard.js";

describe("WorkspaceCommandGuard", () => {
  it("allows repository-native Python and package-manager commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-command-guard-"));
    try {
      await expect(inspectCommand({ workspaceRoot: root, executable: "python", args: ["-m", "pytest", "tests/test_core.py::test_ok"] })).resolves.toEqual({ allowed: true });
      await expect(inspectCommand({ workspaceRoot: root, executable: "python", args: ["tests/runtests.py", "utils_tests"] })).resolves.toEqual({ allowed: true });
      await expect(inspectCommand({ workspaceRoot: root, executable: "python", args: ["-m", "pip", "install", "-e", "."] })).resolves.toEqual({ allowed: true });
      await expect(inspectCommand({ workspaceRoot: root, executable: "pnpm", args: ["test"] })).resolves.toEqual({ allowed: true });
      await expect(inspectCommand({ workspaceRoot: root, executable: "cmd.exe", args: ["/d", "/s", "/c", "dir"] })).resolves.toEqual({ allowed: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows absolute and relative paths inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-command-guard-"));
    try {
      const target = path.join(root, "folder", "fixture.txt");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "fixture", "utf8");
      await expect(inspectCommand({ workspaceRoot: root, shellCommand: `Get-Content '${target}'` })).resolves.toEqual({ allowed: true });
      await expect(inspectCommand({ workspaceRoot: root, shellCommand: "Get-Content .\\folder\\fixture.txt" })).resolves.toEqual({ allowed: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["parent traversal", { shellCommand: "Get-ChildItem .." }, "path_traversal"],
    ["external drive path", { shellCommand: "Get-Content 'C:\\Users\\example\\secret.txt'" }, "external_absolute_path"],
    ["UNC path", { shellCommand: "Get-Content '\\\\server\\share\\secret.txt'" }, "external_absolute_path"],
    ["user profile", { shellCommand: "Get-Content $env:USERPROFILE\\secret.txt" }, "dynamic_external_path"],
    ["home", { shellCommand: "Get-Content ~/secret.txt" }, "dynamic_external_path"],
    ["environment enumeration", { shellCommand: "Get-ChildItem Env:" }, "environment_enumeration"],
    ["drive enumeration", { shellCommand: "Get-PSDrive" }, "environment_enumeration"],
    ["nested cmd", { shellCommand: "cmd /c dir" }, "nested_shell"],
    ["nested pwsh", { shellCommand: "pwsh -Command Get-ChildItem" }, "nested_shell"],
    ["dynamic process", { shellCommand: "Start-Process python -ArgumentList '-V'" }, "dynamic_execution"],
    ["inline Python", { executable: "python", args: ["-c", "print('x')"] }, "inline_code"],
    ["inline Node", { executable: "node", args: ["-e", "console.log('x')"] }, "inline_code"],
    ["interactive cmd", { executable: "cmd.exe", args: ["/c", "dir"] }, "nested_shell"],
    ["cmd external path", { executable: "cmd.exe", args: ["/d", "/s", "/c", "type C:\\Users\\example\\secret.txt"] }, "external_absolute_path"],
  ])("denies %s", async (_name, request, reason) => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-command-guard-"));
    try {
      await expect(inspectCommand({ workspaceRoot: root, ...request })).resolves.toMatchObject({ allowed: false, code: "WORKSPACE_COMMAND_DENIED", reason });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies a workdir outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-command-guard-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cra-command-outside-"));
    try {
      await expect(inspectCommand({ workspaceRoot: root, workdir: outside, executable: "python", args: ["-m", "pytest"] })).resolves.toMatchObject({ allowed: false, reason: "workdir_outside_workspace" });
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("does not copy an environment value into a denial result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-command-guard-"));
    try {
      const secretPath = "C:\\Users\\example\\secret-token-file";
      const decision = await inspectCommand({ workspaceRoot: root, env: { PRIVATE_LOCATION: secretPath } });
      expect(decision).toMatchObject({ allowed: false, reason: "external_absolute_path", offendingValue: "env:PRIVATE_LOCATION" });
      expect(JSON.stringify(decision)).not.toContain("secret-token-file");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies a symlink or junction that resolves outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-command-guard-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cra-command-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(root, "external"), process.platform === "win32" ? "junction" : "dir");
      await expect(inspectCommand({ workspaceRoot: root, shellCommand: "Get-Content .\\external\\secret.txt" })).resolves.toMatchObject({ allowed: false, reason: "symlink_escape" });
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
