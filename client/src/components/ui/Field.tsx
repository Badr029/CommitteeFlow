import { useId, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import styles from './controls.module.css';

/**
 * Form field wrapper.
 *
 * Owns the label/control/help/error relationship so every input in the app is
 * announced the same way: `aria-describedby` points at the help text and the
 * error, and `aria-invalid` marks the control itself.
 */

export interface FieldProps {
  label: string;
  /** The plan's own requiredness, from Plan Configuration. */
  required?: boolean;
  /** Shown when a field is optional and the surrounding form is mostly not. */
  showOptional?: boolean;
  help?: string | null;
  error?: string | undefined;
  className?: string;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
    'aria-required': boolean | undefined;
  }) => ReactNode;
}

export function Field({
  label,
  required = false,
  showOptional = false,
  help,
  error,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={cn(styles.field, className)}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true" title="Required">
            *
          </span>
        )}
        {!required && showOptional && <span className={styles.optional}>optional</span>}
      </label>

      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
        // The visual asterisk is decorative (aria-hidden), so requiredness has
        // to reach assistive technology through the control itself.
        'aria-required': required || undefined,
      })}

      {help && (
        <p className={styles.help} id={helpId}>
          {help}
        </p>
      )}

      {error && (
        <p className={styles.error} id={errorId} role="alert">
          <AlertCircle size={13} strokeWidth={2.2} aria-hidden="true" style={{ marginTop: 2 }} />
          {error}
        </p>
      )}
    </div>
  );
}
