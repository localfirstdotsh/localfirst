import type { ReactNode } from 'react';

/** Controls use id and aria-describedby (when help/error is present); labels never include feedback text. */
export function FormField({ id, label, children, help, error }: {
  id: string;
  label: string;
  children: ReactNode;
  help?: string;
  error?: string;
}) {
  return (
    <div className="stack gap-8 small">
      <label className="muted" htmlFor={id}>{label}</label>
      {children}
      {help && <p id={`${id}-help`} className="muted">{help}</p>}
      {error && <p id={`${id}-error`} className="field-error" role="alert">{error}</p>}
    </div>
  );
}
