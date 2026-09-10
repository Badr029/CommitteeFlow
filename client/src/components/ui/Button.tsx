import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './controls.module.css';

/**
 * The one button in the application.
 *
 * If a "save" control looks different on two screens, one of them is wrong —
 * so every action in CommitteeFlow renders through this component.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'linkish';
type Size = 'small' | 'medium' | 'large';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Swaps the leading icon for a spinner and blocks further clicks. */
  loading?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  /** Icon-only buttons still need an accessible name. */
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'medium',
    loading = false,
    icon,
    iconEnd,
    iconOnly = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        styles.button,
        styles[variant],
        size === 'small' && styles.small,
        size === 'large' && styles.large,
        iconOnly && styles.iconOnly,
        className,
      )}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      {!iconOnly && children}
      {!loading && iconEnd}
    </button>
  );
});
