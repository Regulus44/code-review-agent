import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import path from "node:path";
import { workspacePythonPathEnv } from "./builtin.js";

describe("workspace Python import precedence", () => {
  it("prepends the active workspace to inherited Python paths", () => {
    const root = path.resolve("D:/evaluation/task");
    const env = workspacePythonPathEnv(root, { PYTHONPATH: "D:/other-checkout;D:/shared-packages" }, "win32");
    expect(env["PYTHONPATH"]).toBe(`${root};D:/other-checkout;D:/shared-packages`);
  });

  it("keeps host shell overrides while adding the workspace Python path", () => {
    const root = path.resolve("D:/evaluation/task");
    const env = workspacePythonPathEnv(root, { NO_COLOR: "1" }, "win32");
    expect(env).toMatchObject({ NO_COLOR: "1" });
    expect(env["PYTHONPATH"]?.split(";")[0]).toBe(root);
  });

  it("prefers common src and lib layouts before an inherited checkout", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workspace-python-path-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      mkdirSync(path.join(root, "lib"), { recursive: true });
      writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = 'fixture'\n", "utf8");
      const env = workspacePythonPathEnv(root, { PYTHONPATH: "D:/other-checkout" }, "win32");
      expect(env["PYTHONPATH"]?.split(";").slice(0, 3)).toEqual([path.join(root, "src"), path.join(root, "lib"), root]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
