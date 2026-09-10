import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './controls.module.css';

/**
 * Status chip.
 *
 * Semantic tone is separate from the accent by design: the accent means
 * "selected", a tone means "this is the state of the thing".
 */
export type PillTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const TONE_CLASS: Record<PillTone, string | undefined> = {
  neutral: undefined,
  accent: styles.pillAccent,
  ok: styles.pillOk,
  warn: styles.pillWarn,
  danger: styles.pillDanger,
};

export function Pill({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
}: {
  tone?: PillTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn(styles.pill, TONE_CLASS[tone], className)} title={title}>
      {icon}
      {children}
    </span>
  );
}
