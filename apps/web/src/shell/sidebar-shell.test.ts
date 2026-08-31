import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
const sidebarStart = indexHtml.indexOf('<aside id="sidebar-panel"');
const sidebarEnd = indexHtml.indexOf("</aside>", sidebarStart);
const sidebarHtml = sidebarStart >= 0 && sidebarEnd >= 0 ? indexHtml.slice(sidebarStart, sidebarEnd) : "";

describe("sidebar shell contract", () => {
  it("keeps the fixed shell regions outside the list scrollport", () => {
    expect(sidebarHtml).toContain('class="sidebar-header"');
    expect(sidebarHtml).toContain('class="sidebar-primary"');
    expect(sidebarHtml).toContain('id="new-session"');
    expect(sidebarHtml).toContain('id="archive-toggle"');
    expect(sidebarHtml).toContain('class="workspace-browser-toolbar"');
    expect(sidebarHtml).toContain('class="sidebar-list-scroll"');
    expect(sidebarHtml).toContain('id="session-list"');
    expect(sidebarHtml).toContain('class="sidebar-footer"');

    const listScrollStart = sidebarHtml.indexOf('class="sidebar-list-scroll"');
    const sessionListStart = sidebarHtml.indexOf('id="session-list"', listScrollStart);
    expect(listScrollStart).toBeGreaterThan(-1);
    expect(sessionListStart).toBeGreaterThan(listScrollStart);
    expect(sidebarHtml.indexOf('class="sidebar-footer"')).toBeGreaterThan(sessionListStart);
  });

  it("uses the sidebar content as a non-scrolling flex region", () => {
    expect(indexHtml).toMatch(/\.sidebar-content \{[^}]*display: flex;[^}]*overflow: hidden;/s);
    expect(indexHtml).toMatch(/\.sidebar-list-scroll \{[^}]*min-height: 0;[^}]*overflow: auto;/s);
    expect(indexHtml).toMatch(/\.workspace-browser \{[^}]*min-height: 0;[^}]*flex: 1 1 auto;/s);
  });

  it("keeps typed and fallback navigation on one five-row overflow adapter", () => {
    expect(indexHtml).toContain("typedRuntime?.presentSidebarNavigation");
    expect(indexHtml).toContain("const windowSidebarSessions = (sessions, expanded) =>");
    expect(indexHtml).toContain("typedRuntime?.windowSessionGroup");
    expect(indexHtml).toContain("sessions.slice(0, limit)");
    expect(indexHtml).toContain("className = 'workspace-show-more'");
    expect(indexHtml).toContain("expandedSessionGroups");
  });

  it("routes typed and fallback rows through the compact M3 adapters", () => {
    expect(indexHtml).toContain("const createSidebarSessionRow = (node) =>");
    expect(indexHtml).toContain("typedRuntime?.createSessionRow");
    expect(indexHtml).toContain("const createSidebarWorkspaceRow = (group, expanded, active, onToggle) =>");
    expect(indexHtml).toContain("typedRuntime?.createWorkspaceRow");
    expect(indexHtml).toContain("session-row-detail sr-only");
    expect(indexHtml).toContain("Move workspace up");
    expect(indexHtml).toContain("Move workspace down");
  });

  it("keeps navigation preferences in the Web-only reducer and persistence adapter", () => {
    expect(indexHtml).toContain("createSidebarNavigationPersistence");
    expect(indexHtml).toContain("let sidebarNavigationState");
    expect(indexHtml).toContain("const dispatchSidebarNavigation = (action, options = {}) =>");
    expect(indexHtml).toContain("type: 'set-show-archived'");
    expect(indexHtml).toContain("type: 'set-search-query'");
    expect(indexHtml).toContain("type: 'set-view-mode'");
    expect(indexHtml).toContain("type: 'set-sort'");
    expect(indexHtml).toContain("type: 'retain-workspace-keys'");
    expect(indexHtml).toContain("type: 'remove-workspace-key'");
    expect(indexHtml).toContain("sidebarNavigationPersistence?.save(next)");
    expect(indexHtml).toContain("navigation.activeWorkspaceKey");
  });

  it("keeps local search collapsed until requested and exposes keyboard lifecycle", () => {
    expect(sidebarHtml).toContain('id="session-search-toggle"');
    expect(sidebarHtml).toContain('aria-expanded="false"');
    expect(sidebarHtml).toContain('id="session-search-clear"');
    expect(sidebarHtml).toContain('id="session-search" class="workspace-search" type="search"');
    expect(sidebarHtml).toContain('hidden tabindex="-1"');
    expect(indexHtml).toContain("const setSidebarSearchExpanded = (expanded, focus = false) =>");
    expect(indexHtml).toContain("sessionSearch.addEventListener('keydown'");
    expect(indexHtml).toContain("else if (sidebarSearchExpanded) clearSidebarSearch()");
    expect(indexHtml).toContain("type: 'clear-search'");
  });
});
