import type { ReactNode } from 'react';
import styles from './controls.module.css';

/**
 * Empty state.
 *
 * Teaches the interface rather than reporting absence: it names what would go
 * here and, where the viewer is allowed, offers the action that puts it there.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      {icon && <div className={styles.emptyIcon}>{icon}</div>}
      <p className={styles.emptyTitle}>{title}</p>
      {body && <p className={styles.emptyBody}>{body}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}
