import { Check } from 'lucide-react';
import type { PlanField, PlanFieldValue } from '@shared/api-types';
import { cn } from '@/lib/cn';
import { Field } from '@/components/ui/Field';
import {
  checkboxLabelClass,
  checkboxRowClass,
  controlClass,
  numericClass,
} from '@/components/ui/classes';
import styles from './booking.module.css';

/**
 * One plan field, rendered as the right control for its configured type.
 *
 * This is the only place the booking form knows anything about field types —
 * adding a type means adding a case here, not touching the drawer, the plan or
 * the exports (spec §35, §77).
 */
export function DynamicField({
  field,
  value,
  error,
  disabled,
  autoFocus,
  minDate,
  minTime,
  onChange,
}: {
  field: PlanField;
  value: PlanFieldValue;
  error?: string | undefined;
  disabled?: boolean;
  autoFocus?: boolean;
  minDate?: string;
  minTime?: string;
  onChange: (value: PlanFieldValue) => void;
}) {
  // Only genuinely long values span both columns. Spanning a short field too
  // would leave a hole in the grid beside it without buying any room.
  const wide = field.fieldType === 'LONG_TEXT';

  const common = {
    disabled,
    autoFocus,
  };

  return (
    <Field
      label={field.label}
      required={field.isRequired}
      showOptional={!field.isRequired}
      help={field.helpText}
      error={error}
      className={cn(wide && styles.span2)}
    >
      {(props) => {
        switch (field.fieldType) {
          case 'LONG_TEXT':
            return (
              <textarea
                {...props}
                {...common}
                className={controlClass}
                rows={3}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) => onChange(event.target.value)}
              />
            );

          case 'NUMBER':
            return (
              <input
                {...props}
                {...common}
                className={cn(controlClass, numericClass)}
                type="number"
                inputMode="decimal"
                // Qty is a whole count; KVA and KV are measurements.
                step={field.fieldKey === 'qty' ? 1 : 'any'}
                min={field.fieldKey === 'qty' ? 1 : 0}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) =>
                  onChange(event.target.value === '' ? null : Number(event.target.value))
                }
              />
            );

          case 'SELECT':
            return (
              <select
                {...props}
                {...common}
                className={controlClass}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) => onChange(event.target.value || null)}
              >
                <option value="">
                  {field.isRequired ? `Choose ${field.label.toLowerCase()}` : 'Not set'}
                </option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            );

          case 'DATE':
            return (
              <input
                {...props}
                {...common}
                className={cn(controlClass, numericClass)}
                type="date"
                min={minDate}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) => onChange(event.target.value || null)}
              />
            );

          case 'TIME':
            return (
              <input
                {...props}
                {...common}
                className={cn(controlClass, numericClass)}
                type="time"
                min={minTime}
                step={300}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) => onChange(event.target.value || null)}
              />
            );

          case 'CHECKBOX':
            return (
              <div className={checkboxRowClass}>
                <input
                  {...props}
                  {...common}
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => onChange(event.target.checked)}
                  style={{ width: 17, height: 17, accentColor: 'var(--accent)' }}
                />
                <label className={checkboxLabelClass} htmlFor={props.id}>
                  {value === true ? 'Yes' : 'No'}
                </label>
                {value === true && (
                  <Check size={14} aria-hidden="true" style={{ color: 'var(--ok-ink)' }} />
                )}
              </div>
            );

          case 'TEXT':
          default:
            return (
              <input
                {...props}
                {...common}
                className={cn(controlClass, field.fieldKey === 'off_no' && numericClass)}
                type="text"
                autoComplete="off"
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) => onChange(event.target.value)}
              />
            );
        }
      }}
    </Field>
  );
}
