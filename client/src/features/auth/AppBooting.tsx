import { Skeleton } from '@/components/ui/Skeleton';
import { BrandMark } from '@/components/AppShell';
import styles from './LoginPage.module.css';

/**
 * First paint, before the session is known.
 *
 * Uses the signed-out page shape. Protected plan content is never suggested
 * before the session check finishes.
 */
export function AppBooting() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="Loading CommitteeFlow">
      <header className={styles.topline}>
        <BrandMark />
        <span className={styles.brandName}>CommitteeFlow</span>
        <span className={styles.toplineSpacer} />
        <Skeleton width={28} height={28} />
      </header>
      <main className={styles.center}>
        <div className={styles.panel}>
          <div className={styles.heading}>
            <Skeleton width={190} height={28} />
            <Skeleton width="100%" height={12} />
            <Skeleton width="78%" height={12} />
          </div>
          <div className={styles.form}>
            <Skeleton width={92} height={10} />
            <Skeleton width="100%" height={32} />
            <Skeleton width={64} height={10} />
            <Skeleton width="100%" height={32} />
            <Skeleton width="100%" height={32} />
          </div>
        </div>
      </main>
      <footer className={styles.foot}><Skeleton width={360} height={11} /></footer>
    </div>
  );
}
