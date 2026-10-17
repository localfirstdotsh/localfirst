import type { ComponentProps } from 'react';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`control ${className}`.trim()} />;
}

/** Native select semantics, including keyboard navigation and form ownership, stay with the browser. */
export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`control ${className}`.trim()} />;
}

export function Checkbox({ children, className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <label className={`checkbox-field ${className}`.trim()}>
      <input {...props} type="checkbox" />
      {children}
    </label>
  );
}
