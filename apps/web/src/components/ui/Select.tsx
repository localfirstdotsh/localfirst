'use client';

import { useEffect, useId, useRef, useState } from 'react';

export interface SelectOption { value: string; label: string }

/** Shared single-choice control. Hidden input preserves normal form submission. */
export function Select({ name, label, options, defaultValue = '', disabled, hint, autoSubmit = false }: {
  name: string; label: string; options: SelectOption[]; defaultValue?: string; disabled?: boolean; hint?: string; autoSubmit?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const items = useRef<Array<HTMLDivElement | null>>([]);
  const search = useRef({ text: '', at: 0 });
  const selected = options.findIndex((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    items.current[Math.max(0, selected)]?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, selected]);

  function choose(next: string) {
    setValue(next);
    setOpen(false);
    trigger.current?.focus();
    // requestSubmit must see the new value before React's next render.
    if (input.current) {
      input.current.value = next;
      if (autoSubmit) input.current.form?.requestSubmit();
    }
  }

  return (
    <div className="select-root" ref={root}>
      <input ref={input} type="hidden" name={name} value={value} disabled={disabled} />
      <span id={`${id}-label`} className="visually-hidden">{label}</span>
      <button ref={trigger} type="button" className="select-trigger" role="combobox" aria-labelledby={`${id}-label`} aria-controls={`${id}-list`} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} title={hint}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setOpen(true); }
        }}>
        <span id={`${id}-value`}>{options[selected]?.label ?? 'Choose an option'}</span>
        <svg className="select-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && <div className="select-menu" id={`${id}-list`} role="listbox" aria-label={label}
        onKeyDown={(event) => {
          const index = items.current.indexOf(document.activeElement as HTMLDivElement);
          let next: number | null = null;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
          else if (event.key === 'Tab') setOpen(false);
          else if (event.key === 'ArrowDown') next = (index + 1) % options.length;
          else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = options.length - 1;
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (options[index]) choose(options[index].value);
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const now = Date.now();
            search.current = { text: (now - search.current.at < 600 ? search.current.text : '') + event.key.toLowerCase(), at: now };
            const match = options.findIndex((option) => option.label.toLowerCase().startsWith(search.current.text));
            if (match >= 0) next = match;
          }
          if (next !== null) { event.preventDefault(); items.current[next]?.focus(); }
        }}>
        {options.map((option, index) => <div ref={(el) => { items.current[index] = el; }} key={option.value} className="select-option" role="option" tabIndex={-1} aria-selected={value === option.value} onClick={() => choose(option.value)}>
          {option.label}<span aria-hidden="true">{value === option.value ? '✓' : ''}</span>
        </div>)}
      </div>}
    </div>
  );
}
