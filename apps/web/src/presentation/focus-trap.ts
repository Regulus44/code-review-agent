export const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Return the next focusable index while wrapping at either end of a dialog. */
export function nextFocusableIndex(currentIndex: number, count: number, reverse = false): number {
  if (count <= 0) return -1;
  const start = currentIndex < 0 ? (reverse ? count : -1) : currentIndex;
  return (start + (reverse ? -1 : 1) + count) % count;
}

export interface FocusTrap {
  activate(): void;
  deactivate(): void;
}

/** Keep keyboard focus inside a modal and restore the opener on close. */
export function createFocusTrap(container: HTMLElement, ownerDocument: Document = container.ownerDocument): FocusTrap {
  let active = false;
  let previous: HTMLElement | null = null;

  const focusable = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active || event.key !== "Tab") return;
    const elements = focusable();
    if (elements.length === 0) return;
    const current = ownerDocument.activeElement instanceof HTMLElement
      ? elements.indexOf(ownerDocument.activeElement)
      : -1;
    const next = nextFocusableIndex(current, elements.length, event.shiftKey);
    const target = next < 0 ? undefined : elements[next];
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return {
    activate(): void {
      if (active) return;
      active = true;
      previous = ownerDocument.activeElement instanceof HTMLElement ? ownerDocument.activeElement : null;
      container.addEventListener("keydown", onKeyDown);
      const first = focusable()[0];
      if (first !== undefined && !container.contains(ownerDocument.activeElement)) first.focus();
    },
    deactivate(): void {
      if (!active) return;
      active = false;
      container.removeEventListener("keydown", onKeyDown);
      if (previous !== null && previous.isConnected) previous.focus();
      previous = null;
    },
  };
}
