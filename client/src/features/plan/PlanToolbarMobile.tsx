import { CalendarPlus, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react';
import { formatMonth, formatMonthShort } from '@/lib/format';
import { currentMonthKey, shiftMonth } from '@/lib/months';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { useMediaQuery } from '@/lib/viewport';
import styles from './PlanToolbar.module.css';

export interface ActiveFilterChip {
  key: string;
  label: string;
  onClear: () => void;
}

/**
 * The plan's own controls on a phone or tablet.
 *
 * Month navigation is the one thing that is always on screen, because a plan is
 * always "which month". Search stays visible too — it is how a booking is found
 * by OFF number, which is the most common reason to open this screen at all.
 * Everything else folds into the filter sheet and reappears as chips once it is
 * actually doing something.
 */
export function PlanToolbarMobile({
  month,
  searchDraft,
  onSearchChange,
  onMonthChange,
  onOpenFilters,
  activeFilterCount,
  chips,
  onClearAll,
  canBook,
  onBook,
}: {
  month: string;
  searchDraft: string;
  onSearchChange: (value: string) => void;
  onMonthChange: (month: string) => void;
  onOpenFilters: () => void;
  activeFilterCount: number;
  chips: ActiveFilterChip[];
  onClearAll: () => void;
  canBook: boolean;
  onBook: () => void;
}) {
  const isCurrentMonth = month === currentMonthKey();
  // Below ~380px "September 2026" and the booking control cannot share a row.
  const tightMonth = useMediaQuery('(max-width: 379px)');

  return (
    <div className={styles.toolbar}>
      <div className={styles.monthRow}>
        <button
          type="button"
          className={styles.monthStep}
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          aria-label={`Previous month, ${formatMonthShort(shiftMonth(month, -1))}`}
        >
          <ChevronLeft size={18} />
        </button>

        <h1 className={styles.monthLabel} aria-live="polite">
          {tightMonth ? formatMonthShort(month) : formatMonth(month)}
        </h1>

        <button
          type="button"
          className={styles.monthStep}
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          aria-label={`Next month, ${formatMonthShort(shiftMonth(month, 1))}`}
        >
          <ChevronRight size={18} />
        </button>

        <span className={styles.monthSpacer} />

        {/* Only offered when it would actually move you. */}
        {!isCurrentMonth && (
          <Button
            variant="secondary"
            className={styles.todayButton}
            onClick={() => onMonthChange(currentMonthKey())}
          >
            Today
          </Button>
        )}

        {canBook && (
          <Button
            variant="primary"
            className={styles.bookButton}
            icon={<CalendarPlus size={15} />}
            onClick={onBook}
          >
            Book
          </Button>
        )}
      </div>

      <div className={styles.searchRow}>
        <div className={styles.search}>
          <Search size={15} className={styles.searchIcon} aria-hidden="true" />
          <input
            className={styles.searchInput}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            value={searchDraft}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search OFF, order, customer"
            aria-label="Search the plan"
          />
          {searchDraft && (
            <button
              type="button"
              className={styles.clearSearch}
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <button
          type="button"
          className={cn(styles.filterButton, activeFilterCount > 0 && styles.filterButtonOn)}
          onClick={onOpenFilters}
          aria-label={
            activeFilterCount > 0
              ? `Filters, ${activeFilterCount} active`
              : 'Filters'
          }
        >
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span className={styles.filterButtonLabel}>Filters</span>
          {activeFilterCount > 0 && (
            <span className={styles.filterCount} aria-hidden="true">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {chips.length > 0 && (
        <div className={styles.chipRow}>
          <ul className={styles.chips}>
            {chips.map((chip) => (
              <li key={chip.key}>
                <button type="button" className={styles.chip} onClick={chip.onClear}>
                  {chip.label}
                  <X size={13} aria-hidden="true" />
                  <span className="sr-only">Remove this filter</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.clearAll} onClick={onClearAll}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
