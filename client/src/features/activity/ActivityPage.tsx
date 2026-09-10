import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ActivityEntry } from '@shared/api-types';
import { ApiError } from '@/api/client';
import { useActivity } from '@/api/queries';
import { cn } from '@/lib/cn';
import { EMPTY, formatClock, formatDateCompact, formatRelative, formatTimestamp } from '@/lib/format';
import { monthKeyOf } from '@/lib/months';
import { useIsCompact } from '@/lib/viewport';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import styles from './ActivityPage.module.css';

const PAGE_SIZE = 50;

/**
 * Activity (spec §14).
 *
 * The product's promise is an auditable source of truth, so this is the feed
 * that answers "who changed what, and when". Paginated by design — it never
 * loads the whole audit table (spec §56).
 */
export function ActivityPage() {
  const [page, setPage] = useState(1);
  const activity = useActivity(page, PAGE_SIZE);
  /*
   * On a narrow screen the timestamp rail becomes a day heading and a clock, so
   * the feed reads as "today, then yesterday" rather than repeating the full
   * date on every entry.
   */
  const compact = useIsCompact();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <h1 className={styles.title}>Activity</h1>
          <p className={styles.subtitle}>
            Every change to the Committee Plan, newest first.
          </p>
        </div>
        <span className={styles.spacer} />
        <Button
          variant="ghost"
          size="small"
          icon={<RefreshCw size={13} />}
          loading={activity.isFetching && !activity.isPending}
          onClick={() => void activity.refetch()}
        >
          Refresh
        </Button>
      </header>

      <div className={styles.scroll}>
        <div className={styles.column}>
          {activity.isPending ? (
            <ActivitySkeleton />
          ) : activity.isError ? (
            <EmptyState
              title="Activity could not be loaded"
              body={
                activity.error instanceof ApiError
                  ? activity.error.message
                  : 'Something went wrong reaching the server.'
              }
              action={
                <Button variant="secondary" onClick={() => void activity.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : activity.data.entries.length === 0 ? (
            <EmptyState
              icon={<History size={26} strokeWidth={1.5} />}
              title={page === 1 ? 'Nothing has happened yet' : 'No more activity'}
              body={
                page === 1
                  ? 'As soon as someone books, edits or cancels a committee slot, it appears here with who did it and what changed.'
                  : 'You have reached the end of the history.'
              }
              action={
                page > 1 ? (
                  <Button variant="secondary" onClick={() => setPage(1)}>
                    Back to the latest
                  </Button>
                ) : (
                  <Button variant="secondary" as-child={undefined}>
                    <Link to="/plan">Open the Committee Plan</Link>
                  </Button>
                )
              }
            />
          ) : (
            <>
              {compact ? (
                groupByDay(activity.data.entries).map((group) => (
                  <section key={group.key} className={styles.dayGroup}>
                    <h2 className={styles.dayHeading}>{group.label}</h2>
                    <ol className={styles.feed}>
                      {group.entries.map((entry) => (
                        <ActivityRow key={entry.id} entry={entry} compact />
                      ))}
                    </ol>
                  </section>
                ))
              ) : (
                <ol className={styles.feed}>
                  {activity.data.entries.map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))}
                </ol>
              )}

              <nav className={styles.pager} aria-label="Activity pages">
                <Button
                  variant="secondary"
                  icon={<ChevronLeft size={14} />}
                  disabled={page === 1 || activity.isFetching}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Newer
                </Button>
                <span className={styles.pagerLabel}>Page {page}</span>
                <Button
                  variant="secondary"
                  iconEnd={<ChevronRight size={14} />}
                  disabled={!activity.data.hasMore || activity.isFetching}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Older
                </Button>
              </nav>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ entry, compact = false }: { entry: ActivityEntry; compact?: boolean }) {
  const booking = entry.booking;
  const identifier = booking?.offNo ?? booking?.orderName ?? 'a booking';

  /*
   * Cancelled and deleted must never read the same. One says a committee is no
   * longer coming and the booking is still on the plan; the other says the row
   * should never have existed and has gone.
   */
  const verb =
    entry.action === 'CREATE'
      ? 'booked'
      : entry.action === 'CANCEL'
        ? 'cancelled'
        : entry.action === 'DELETE'
          ? 'deleted'
          : 'changed';

  return (
    <li className={styles.entry}>
      <time className={styles.time} dateTime={entry.createdAt} title={entry.createdAt}>
        {/* The day is already the heading on a narrow screen; only the clock
            has to repeat. */}
        <span className={styles.timeClock}>
          {compact ? formatClock(entry.createdAt) : formatTimestamp(entry.createdAt)}
        </span>
        {!compact && <span className={styles.timeRelative}>{formatRelative(entry.createdAt)}</span>}
      </time>

      <span
        className={cn(
          styles.marker,
          entry.action === 'CREATE' && styles.markerCreate,
          entry.action === 'CANCEL' && styles.markerCancel,
          entry.action === 'DELETE' && styles.markerDelete,
        )}
        aria-hidden="true"
      >
        {entry.action === 'CREATE' ? (
          <Plus size={12} />
        ) : entry.action === 'CANCEL' ? (
          <Ban size={12} />
        ) : entry.action === 'DELETE' ? (
          <Trash2 size={12} />
        ) : (
          <Pencil size={12} />
        )}
      </span>

      <div className={styles.body}>
        <p className={styles.headline}>
          <span className={styles.actor}>{entry.actor?.name ?? 'Someone'}</span> {verb}{' '}
          {booking ? (
            <Link
              className={styles.bookingLink}
              to={`/plan?month=${monthKeyOf(booking.bookingDate)}&booking=${booking.id}`}
            >
              {identifier}
            </Link>
          ) : (
            <span>{identifier}</span>
          )}
          {booking && (
            <span className={styles.context}>
              {' · '}
              {formatDateCompact(booking.bookingDate)}
              {booking.committee ? ` · ${booking.committee}` : ''}
            </span>
          )}
        </p>

        {entry.action === 'UPDATE' && entry.changes.length > 0 && (
          <ul className={styles.changes}>
            {entry.changes.map((change) => (
              <li key={change.fieldKey} className={styles.change}>
                <span className={styles.changeLabel}>{change.label}</span>
                <span className={styles.changeFrom}>{show(change.from)}</span>
                <span className={styles.changeArrow} aria-label="changed to">
                  →
                </span>
                <span className={styles.changeTo}>{show(change.to)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Groups the feed into days.
 *
 * Uses the viewer's own timezone, because an activity entry is a real instant —
 * unlike a booking date, which is a plain calendar day.
 */
function groupByDay(
  entries: ActivityEntry[],
): Array<{ key: string; label: string; entries: ActivityEntry[] }> {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const dayKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  const groups: Array<{ key: string; label: string; entries: ActivityEntry[] }> = [];

  for (const entry of entries) {
    const when = new Date(entry.createdAt);
    const key = Number.isNaN(when.getTime()) ? 'unknown' : dayKey(when);
    const label =
      key === dayKey(today)
        ? 'Today'
        : key === dayKey(yesterday)
          ? 'Yesterday'
          : key === 'unknown'
            ? 'Earlier'
            : formatDateCompact(key);

    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, label, entries: [entry] });
  }

  return groups;
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function ActivitySkeleton() {
  return (
    <ol className={styles.feed} aria-busy="true" aria-label="Loading activity">
      {Array.from({ length: 8 }, (_, index) => (
        <li key={index} className={styles.entry}>
          <div className={styles.time}>
            <Skeleton width={116} height={11} />
            <Skeleton width={68} height={10} />
          </div>
          <Skeleton width={22} height={22} />
          <div className={styles.body}>
            <Skeleton width={index % 3 === 0 ? '58%' : '76%'} height={12} />
            {index % 3 === 1 && <Skeleton width="42%" height={10} />}
          </div>
        </li>
      ))}
    </ol>
  );
}
