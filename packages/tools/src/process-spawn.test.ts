import { describe, expect, it } from "vitest";
import { hiddenProcessSpawnOptions } from "./process-spawn.js";

describe("Agent-owned process spawn policy", () => {
  it("keeps Windows children attached and hides their console window", () => {
    expect(hiddenProcessSpawnOptions("win32")).toEqual({ detached: false, shell: false, windowsHide: true });
  });

  it("retains detached POSIX process groups for tree cancellation", () => {
    expect(hiddenProcessSpawnOptions("linux")).toEqual({ detached: true, shell: false, windowsHide: true });
    expect(hiddenProcessSpawnOptions("darwin")).toEqual({ detached: true, shell: false, windowsHide: true });
  });
});
