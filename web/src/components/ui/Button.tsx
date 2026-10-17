import type { ComponentProps } from 'react';

type ButtonVariant = 'default' | 'primary';
type ButtonSize = 'default' | 'small';
interface ButtonAppearance {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** Apply the same treatment to native anchors and Next Link without changing their navigation semantics. */
export function buttonClassName({ variant = 'default', size = 'default', className = '' }: ButtonAppearance = {}): string {
  return ['button', variant === 'primary' && 'button-primary', size === 'small' && 'button-small', className]
    .filter(Boolean)
    .join(' ');
}

export function Button({ variant, size, loading = false, disabled, className, type = 'button', ...props }:
  ComponentProps<'button'> & ButtonAppearance & { loading?: boolean }) {
  return (
    <button
      {...props}
      type={type}
      className={buttonClassName({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || props['aria-busy']}
    />
  );
}
