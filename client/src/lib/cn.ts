import clsx, { type ClassValue } from 'clsx';

/** Conditional class names. CSS Modules keys are already unique, so no merge. */
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}
