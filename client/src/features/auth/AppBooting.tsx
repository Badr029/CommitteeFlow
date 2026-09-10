import { Skeleton } from '@/components/ui/Skeleton';
import { BrandMark } from '@/components/AppShell';
import { PlanTableSkeleton, PLACEHOLDER_COLUMNS } from '@/features/plan/PlanTable';
import shell from '@/components/AppShell.module.css';
import plan from '@/features/plan/PlanPage.module.css';

/**
 * First paint, before the session is known.
 *
 * Renders the shape of the plan rather than a spinner or a blank screen, so the
 * layout does not jump when the real data arrives a moment later.
 */
export function AppBooting() {
  return (
    <div className={shell.shell} aria-busy="true" aria-label="Loading CommitteeFlow">
      <header className={shell.bar}>
        <span className={shell.brand}>
          <BrandMark />
          <span className={shell.brandName}>CommitteeFlow</span>
        </span>
        <nav className={shell.nav}>
          <Skeleton width={104} height={12} />
          <Skeleton width={54} height={12} />
        </nav>
        <span className={shell.spacer} />
        <Skeleton width={92} height={12} />
      </header>

      <main className={shell.main}>
        <div className={plan.page}>
          <div className={plan.toolbar}>
            <div className={plan.monthNav}>
              <Skeleton width={84} height={28} />
              <Skeleton width={132} height={20} />
              <Skeleton width={84} height={28} />
            </div>
            <span className={plan.toolbarSpacer} />
            <div className={plan.filters}>
              <Skeleton width={220} height={28} />
              <Skeleton width={140} height={28} />
              <Skeleton width={112} height={28} />
            </div>
          </div>

          <div className={plan.summary}>
            <Skeleton width={190} height={11} />
          </div>

          <div className={plan.scroll}>
            <PlanTableSkeleton columns={PLACEHOLDER_COLUMNS} />
          </div>
        </div>
      </main>
    </div>
  );
}
