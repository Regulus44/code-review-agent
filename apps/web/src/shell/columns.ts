/** Resolved three-column widths for one frame. */
export interface ShellColumns {
  readonly sidebar: number;
  readonly center: number;
  readonly details: number;
}

export const CENTER_MIN = 640;
export const SIDEBAR_MIN = 264;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 280;
export const SIDEBAR_COLLAPSED = 56;
export const SIDEBAR_AUTO_COLLAPSE = 1024;
export const DETAILS_MIN = 300;
export const DETAILS_MAX = 520;
export const DETAILS_DEFAULT = 360;

export function clampWidth(px: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return min;
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * Resolve the actual frame tracks from transient width preferences.
 * Details yields before Center drops below CENTER_MIN; Sidebar never yields.
 */
export function computeShellColumns(viewport: number, sidebar: number, details: number): ShellColumns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX);

  if (s + d0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - d0, details: d0 };
  }

  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN);
  if (s + d1 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: CENTER_MIN, details: d1 };
  }

  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 };
}
