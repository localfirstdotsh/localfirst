'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

const PHONE = '(max-width: 639px)';
const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])';

/**
 * Domain-agnostic popover for a group of form controls. It is a native <details>, so it opens
 * and closes without JavaScript; this adds the dialog behaviour: focus moves in, Tab stays
 * inside, Escape or a click outside closes and returns focus, and unapplied checkbox choices
 * are discarded on close. On a phone the same panel becomes a bottom sheet and the page behind
 * it does not scroll.
 */
export function FilterPopover({ label, badge, children }: { label: string; badge?: number; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (!open) {
      // Closed without applying: restore every checkbox to its applied state.
      root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
        box.checked = box.defaultChecked;
      });
      return;
    }
    const panel = root.querySelector<HTMLElement>('.popover-panel');
    const trigger = root.querySelector<HTMLElement>(':scope > summary');
    const phone = window.matchMedia(PHONE).matches;
    const previousOverflow = document.body.style.overflow;
    if (phone) document.body.style.overflow = 'hidden';
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const close = () => {
      root.open = false;
      trigger?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel?.contains(event.target) && !trigger?.contains(event.target)) {
        root.open = false;
      }
    };
    root.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      root.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <details ref={ref} className="popover" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="button popover-trigger">
        {label}
        {badge ? (
          <span className="count" aria-label={`${badge} selected`}>
            {badge}
          </span>
        ) : null}
      </summary>
      <div className="popover-backdrop" aria-hidden="true" />
      <div className="popover-panel" role="dialog" aria-label={label}>
        {children}
      </div>
    </details>
  );
}
