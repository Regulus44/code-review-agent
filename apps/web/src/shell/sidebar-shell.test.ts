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

  it("keeps low-frequency integrations and tasks out of the sidebar", () => {
    expect(sidebarHtml).not.toContain("class=\"sidebar-secondary\"");
    expect(sidebarHtml).not.toContain('id="mcp-list"');
    expect(sidebarHtml).not.toContain('id="subagent-list"');
    expect(sidebarHtml).toContain('id="sidebar-attention"');
    expect(sidebarHtml).toContain('id="sidebar-attention-button"');
    expect(sidebarHtml).toContain('aria-controls="details-panel"');
  });

  it("projects attention into one accessible badge and routes it to Details", () => {
    expect(indexHtml).toContain("presentSidebarAttention");
    expect(indexHtml).toContain("const renderSidebarAttention = (snapshot) =>");
    expect(indexHtml).toContain("sidebarAttentionButton.dataset.group = intent.targetGroup || ''");
    expect(indexHtml).toContain("const openDetailsGroup = (groupId) =>");
    expect(indexHtml).toContain("if (state.layout.details !== 'open') dispatchShellLayout({ type: 'toggle-details' })");
    expect(indexHtml).toContain("sidebarAttentionButton?.addEventListener('click'");
    expect(indexHtml).toContain("details-group-${groupId}");
  });

  it("covers the M7 keyboard, ARIA, focus, and navigation matrix", () => {
    const controls = [
      ['sidebar collapse', 'id="sidebar-toggle"', 'aria-label="收起侧栏"'],
      ['new session', 'id="new-session"', 'type="button"'],
      ['archive toggle', 'id="archive-toggle"', 'aria-pressed="false"'],
      ['search toggle', 'id="session-search-toggle"', 'aria-expanded="false"'],
      ['search input', 'id="session-search"', 'type="search"'],
      ['attention button', 'id="sidebar-attention-button"', 'aria-controls="details-panel"'],
    ];
    for (const [label, id, marker] of controls) {
      expect(sidebarHtml, `${label} is missing`).toContain(id);
      expect(sidebarHtml, `${label} is missing ${marker}`).toContain(marker);
    }

    // DSH's sidebar/workspace tests treat the list as a keyboard-reachable
    // region, while row actions appear only on hover/focus and keep their
    // semantics in the DOM. Keep that matrix explicit for the static shell.
    expect(sidebarHtml).toContain('role="region" aria-label="工作区和会话列表" tabindex="0"');
    expect(indexHtml).toContain("header.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') {");
    expect(indexHtml).toContain("sessionSearch.addEventListener('keydown'");
    expect(indexHtml).toContain("sidebarAttentionButton?.addEventListener('click'");
    expect(indexHtml).toContain("group.querySelector('summary')?.focus()");
    expect(indexHtml).toContain("menu.setAttribute('aria-label', `工作区操作 · ${label}`)");
    expect(indexHtml).toContain("menu.setAttribute('aria-label', `会话操作 · ${label}`)");
    expect(indexHtml).toContain("className = 'workspace-show-more'");
    expect(indexHtml).toContain("sessions.slice(0, limit)");
  });
});
