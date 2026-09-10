import { cn } from '@/lib/cn';
import styles from './controls.module.css';

/**
 * Loading placeholder.
 *
 * The plan loads as a skeleton of its own rows rather than a spinner, so the
 * page does not reflow when the data lands.
 */
export function Skeleton({
  width,
  height = 12,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <span
      className={cn(styles.skeleton, className)}
      style={{ display: 'block', width: width ?? '100%', height }}
      aria-hidden="true"
    />
  );
}
