import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import styles from './PlanConfigPage.module.css';

export function PaginationControls({
  page,
  pageSize,
  total,
  loading,
  itemLabel,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  itemLabel: string;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className={styles.pagination} aria-label={`${itemLabel} pages`}>
      <span className={styles.paginationSummary} aria-live="polite">
        {total === 0 ? `No ${itemLabel}` : `${first}–${last} of ${total.toLocaleString()}`}
      </span>
      <div className={styles.paginationActions}>
        <Button
          variant="secondary"
          size="small"
          icon={<ChevronLeft size={13} />}
          disabled={page <= 1 || loading}
          aria-label={`Previous ${itemLabel} page`}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span className={styles.paginationPage}>
          Page {page.toLocaleString()} of {pageCount.toLocaleString()}
        </span>
        <Button
          variant="secondary"
          size="small"
          iconEnd={<ChevronRight size={13} />}
          disabled={page >= pageCount || loading}
          aria-label={`Next ${itemLabel} page`}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
