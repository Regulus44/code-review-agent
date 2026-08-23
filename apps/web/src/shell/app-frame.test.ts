import { describe, expect, it } from "vitest";
import { applyShellFrame, mountShellFrame, type ShellFrameElements } from "./app-frame.js";

function element(): HTMLElement {
  return {
    className: "",
    hidden: false,
    setAttribute: () => undefined,
  } as unknown as HTMLElement;
}

describe("physical Shell frame", () => {
  it("applies only the frame-owned class and mobile menu semantics", () => {
    const app = element();
    const mobileMenu = element() as unknown as HTMLButtonElement;
    const attributes = new Map<string, string>();
    mobileMenu.setAttribute = (name: string, value: string) => { attributes.set(name, value); };
    applyShellFrame({ app, mobileMenu } satisfies ShellFrameElements, {
      appClassName: "app-shell details-collapsed mobile-sidebar-open",
      sidebarCollapsed: false,
      detailsOpen: false,
      mobileSidebarOpen: true,
      mobileMenuVisible: true,
      detailsToggleVisible: false,
    });
    expect(app.className).toBe("app-shell details-collapsed mobile-sidebar-open");
    expect(mobileMenu.hidden).toBe(false);
    expect(attributes).toEqual(new Map([["aria-expanded", "true"], ["aria-label", "Close sidebar"]]));
  });

  it("returns undefined when the static fallback does not expose the frame contract", () => {
    const root = { querySelector: () => null } as unknown as ParentNode;
    expect(mountShellFrame(root)).toBeUndefined();
  });
});
