import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileSpreadsheet,
  FileText,
  Upload,
  Search,
  X,
} from 'lucide-react';
import type { Booking } from '@shared/api-types';
import { ApiError, downloadExport, queryString } from '@/api/client';
import { useBookings, usePlanFields, useSession } from '@/api/queries';
import { cn } from '@/lib/cn';
import { formatDayHeading, formatMonth, formatMonthShort } from '@/lib/format';
import { currentMonthKey, isValidMonthKey, shiftMonth, todayKey } from '@/lib/months';
import { useViewport } from '@/lib/viewport';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { BookingDrawer } from '@/features/bookings/BookingDrawer';
import { BookingDetailDrawer } from '@/features/bookings/BookingDetailDrawer';
import { PlanTable, PlanTableSkeleton } from './PlanTable';
import { PlanAgenda, PlanAgendaSkeleton } from './PlanAgenda';
import { PlanToolbarMobile, type ActiveFilterChip } from './PlanToolbarMobile';
import { PlanFilterSheet, type PlanFilters } from './PlanFilterSheet';
import { SessionSheet } from './SessionSheet';
import { ImportDrawer } from '@/features/plan-import/ImportDrawer';
import {
  filterToDay,
  groupIntoDays,
  tableColumns,
  type CommitteeSession,
  type PlanDay,
} from './sessions';
import styles from './PlanPage.module.css';

/**
 * The Committee Plan — the home screen and the operational dashboard (spec §8).
 *
 * State that describes *what you are looking at* lives in the URL, so a plan
 * view can be sent to a colleague and a notification email can deep-link to the
 * month a booking belongs to — including, on a phone, which committee session
 * is open.
 *
 * One page, three shapes. Everything above the return statement — the query, the
 * filters, the permissions, the session grouping, the drawers — is shared. Only
 * the presentation forks: a table where there is width for its columns, an
 * agenda of committee sessions where there is not.
 */
export function PlanPage() {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const planFields = usePlanFields();

  const monthParam = params.get('month');
  const month = isValidMonthKey(monthParam) ? monthParam : currentMonthKey();
  const today = todayKey();

  const search = params.get('q') ?? '';
  const committee = params.get('committee') ?? '';
  const status = params.get('status') ?? '';
  const onlyMine = params.get('mine') === '1';
  const projectEngineer = params.get('engineer') ?? '';
  const includeCancelled = params.get('cancelled') !== '0';
  const showPastDays = params.get('past') === '1';
  const focusedBookingId = params.get('booking');
  // A day of the month, as `YYYY-MM-DD`, or null for the whole month.
  const day = dayInMonth(params.get('day'), month);

  const user = session.data?.user;
  const canBook = user?.permissions.canCreateBooking ?? false;

  const viewport = useViewport();
  const isCompact = viewport !== 'desktop';

  // Debounced so typing does not fire a request per keystroke.
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);
  useEffect(() => {
    if (searchDraft === search) return undefined;
    const timer = setTimeout(() => setParam('q', searchDraft || null), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  /**
   * Moving to another month drops the day filter with it.
   *
   * `2026-09-13` means nothing in October, and silently keeping it would leave
   * the control showing a day the plan is not filtered by.
   */
  const setMonth = useCallback(
    (next: string) => {
      setParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          updated.set('month', next);
          updated.delete('day');
          updated.delete('session');
          updated.delete('past');
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const bookings = useBookings({
    month,
    ...(search ? { search } : {}),
    ...(committee ? { committee } : {}),
    ...(status ? { status } : {}),
    /*
     * Both narrow to an engineer's own projects, so the explicit filter wins
     * when it is set — otherwise "Only my bookings" would fight it.
     *
     * The value is the project engineer, not the creator: after an import every
     * row in the month shares one creator, and filtering by that answered a
     * question nobody was asking.
     */
    ...(projectEngineer
      ? { projectEngineer }
      : onlyMine && user
        ? { projectEngineer: user.id }
        : {}),
    ...(includeCancelled ? { includeCancelled: true } : {}),
  });

  const columns = useMemo(() => tableColumns(planFields.data ?? []), [planFields.data]);
  const allDays = useMemo(() => groupIntoDays(bookings.data?.bookings ?? []), [bookings.data]);
  const currentMonth = month === currentMonthKey();
  const visibleDays = useMemo(
    () => currentMonth && !showPastDays ? allDays.filter((entry) => entry.date >= today) : allDays,
    [allDays, currentMonth, showPastDays, today],
  );
  const days = useMemo(() => filterToDay(visibleDays, day), [visibleDays, day]);

  // Drawer state. `create` carries the session an engineer chose to join.
  const [composing, setComposing] = useState<
    { mode: 'create'; prefill: Partial<Record<string, string>> } | null
  >(null);
  const [recentlyChangedId, setRecentlyChangedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  /*
   * Which days and sessions are folded away.
   *
   * View state, not plan state — which days someone folded while reading is not
   * something they would send to a colleague, so it stays out of the URL. It
   * lives here rather than in the table because "Collapse all" sits in the
   * summary strip and the two have to agree.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /*
   * A month's folded days mean nothing in the next month, and leaving them
   * folded would hide days the reader has not seen yet.
   */
  useEffect(() => {
    setCollapsed(new Set());
  }, [month]);

  /*
   * "All collapsed" asks about the days on screen, not about the set: a filter
   * can leave a folded day out of view, and the button should still offer to
   * fold what is actually showing.
   */
  const allCollapsed = days.length > 0 && days.every((entry) => collapsed.has(entry.date));

  const toggleAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(days.map((entry) => entry.date)));
  };

  const openDetail = (booking: Booking) => setParam('booking', booking.id);
  const closeDetail = () => setParam('booking', null);

  const markChanged = (booking: Booking) => {
    setRecentlyChangedId(booking.id);
    setTimeout(() => setRecentlyChangedId((id) => (id === booking.id ? null : id)), 2000);
  };

  const startBooking = (prefill: Partial<Record<string, string>> = {}) =>
    setComposing({ mode: 'create', prefill });

  const addToSession = (committeeSession: CommitteeSession) =>
    startBooking({
      booking_date: committeeSession.bookingDate,
      booking_time: committeeSession.bookingTime,
      ...(committeeSession.committee ? { committee: committeeSession.committee } : {}),
    });

  const runExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      await downloadExport(
        `/api/export/${format}${queryString({
          month,
          search: search || undefined,
          committee: committee || undefined,
          status: status || undefined,
          projectEngineer: projectEngineer || (onlyMine && user ? user.id : undefined),
          includeCancelled: includeCancelled ? 'true' : 'false',
        })}`,
        `committee-plan-${month}.${format === 'excel' ? 'xlsx' : 'pdf'}`,
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'The export could not be produced.',
      );
    } finally {
      setExporting(null);
    }
  };

  const facets = bookings.data?.facets;
  const total = days.reduce((sum, entry) => sum + entry.bookingCount, 0);
  const sessionCount = days.reduce((sum, entry) => sum + entry.sessions.length, 0);
  const filtered = Boolean(search || committee || status || onlyMine || projectEngineer || day || !includeCancelled);

  /*
   * The open committee session lives in the URL like the open booking does, so
   * the phone's back button closes the sheet instead of leaving the plan, and a
   * session can be sent to someone.
   */
  const openSessionKey = params.get('session');
  const openSession = useMemo(() => {
    if (!openSessionKey) return null;
    // Searched across the whole month, not the filtered view: a link to a
    // session must open it even when the day filter would have hidden it.
    for (const entry of allDays) {
      const found = entry.sessions.find((candidate) => candidate.key === openSessionKey);
      if (found) return found;
    }
    return null;
  }, [openSessionKey, allDays]);

  const clearFilters = () => {
    setParams({ month }, { replace: true });
    setSearchDraft('');
  };

  const chips: ActiveFilterChip[] = [
    ...(day
      ? [
          {
            key: 'day',
            label: formatDayHeading(day),
            onClear: () => setParam('day', null),
          },
        ]
      : []),
    ...(committee
      ? [{ key: 'committee', label: committee, onClear: () => setParam('committee', null) }]
      : []),
    ...(status ? [{ key: 'status', label: status, onClear: () => setParam('status', null) }] : []),
    ...(projectEngineer
      ? [
          {
            key: 'engineer',
            label:
              facets?.engineers.find((engineer) => engineer.id === projectEngineer)?.name ??
              'Project Engineer',
            onClear: () => setParam('engineer', null),
          },
        ]
      : []),
    ...(onlyMine
      ? [{ key: 'mine', label: 'Only my bookings', onClear: () => setParam('mine', null) }]
      : []),
    ...(!includeCancelled
      ? [
          {
            key: 'cancelled',
            label: 'Cancelled hidden',
            onClear: () => setParam('cancelled', null),
          },
        ]
      : []),
    ...(currentMonth && showPastDays
      ? [{ key: 'past', label: 'Past days shown', onClear: () => setParam('past', null) }]
      : []),
  ];

  const applyFilters = (next: PlanFilters) => {
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        const write = (key: string, value: string | null) => {
          if (value === null || value === '') updated.delete(key);
          else updated.set(key, value);
        };
        write('day', next.day);
        write('committee', next.committee);
        write('status', next.status);
        write('engineer', next.projectEngineer);
        write('mine', next.onlyMine ? '1' : null);
        write('cancelled', next.includeCancelled ? null : '0');
        write('past', currentMonth && next.showPastDays ? '1' : null);
        return updated;
      },
      { replace: true },
    );
    setFiltersOpen(false);
  };

  return (
    <div className={styles.page}>
      {isCompact ? (
        <PlanToolbarMobile
          month={month}
          searchDraft={searchDraft}
          onSearchChange={setSearchDraft}
          onMonthChange={setMonth}
          onOpenFilters={() => setFiltersOpen(true)}
          activeFilterCount={chips.length}
          chips={chips}
          onClearAll={clearFilters}
          canBook={canBook}
          onBook={() => startBooking()}
        />
      ) : (
        <div className={styles.toolbar}>
          <div className={styles.monthNav}>
            <Button
              variant="secondary"
              icon={<ChevronLeft size={14} />}
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              {formatMonthShort(shiftMonth(month, -1))}
            </Button>

            <h1 className={styles.monthLabel} aria-live="polite">
              {formatMonth(month)}
            </h1>

            <Button
              variant="secondary"
              iconEnd={<ChevronRight size={14} />}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              {formatMonthShort(shiftMonth(month, 1))}
            </Button>

            <Button
              variant="ghost"
              onClick={() => setMonth(currentMonthKey())}
              disabled={month === currentMonthKey()}
            >
              Today
            </Button>
          </div>

          <span className={styles.toolbarSpacer} />

          <div className={styles.filters}>
            <div className={styles.search}>
              <Search size={14} className={styles.searchIcon} aria-hidden="true" />
              <input
                className={styles.searchInput}
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Search OFF, order, customer"
                aria-label="Search the plan"
              />
              {searchDraft && (
                <button
                  type="button"
                  className={styles.clearSearch}
                  onClick={() => setSearchDraft('')}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <DaySelect
              value={day}
              days={visibleDays}
              onChange={(value) => setParam('day', value)}
            />
            <FacetSelect
              label="Committee"
              value={committee}
              options={facets?.committees ?? []}
              onChange={(value) => setParam('committee', value)}
            />
            <FacetSelect
              label="Status"
              value={status}
              options={facets?.statuses ?? []}
              labelFor={(value) => (value === 'CANCELLED' ? 'Cancelled' : 'Planned')}
              onChange={(value) => setParam('status', value)}
            />

            {/*
              * Whose project it is, not who typed it. Only engineers who
              * actually own something this month are listed.
              */}
            <FacetSelect
              label="Engineer"
              value={projectEngineer}
              options={(facets?.engineers ?? []).map((engineer) => engineer.id)}
              labelFor={(id) =>
                facets?.engineers.find((engineer) => engineer.id === id)?.name ?? id
              }
              onChange={(value) => setParam('engineer', value)}
            />

            {/* "My bookings" is a filter, not a page (spec §7). */}
            <label className={styles.toggleFilter} data-on={onlyMine}>
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(event) => setParam('mine', event.target.checked ? '1' : null)}
              />
              Only my bookings
            </label>

            {currentMonth && (
              <Button variant="secondary" onClick={() => setParam('past', showPastDays ? null : '1')}>
                {showPastDays ? 'Hide past days' : 'Show past days'}
              </Button>
            )}

            <label className={styles.toggleFilter} data-on={!includeCancelled}>
              <input
                type="checkbox"
                checked={!includeCancelled}
                onChange={(event) => setParam('cancelled', event.target.checked ? '0' : null)}
              />
              Hide cancelled
            </label>

            {canBook && (
              <Button variant="primary" icon={<CalendarPlus size={14} />} onClick={() => startBooking()}>
                Book Committee Slot
              </Button>
            )}
          </div>
        </div>
      )}

      <div className={styles.summary}>
        {bookings.isPending ? (
          <span>Loading the plan…</span>
        ) : (
          <>
            <span>
              <span className={styles.summaryFigure}>{total}</span>{' '}
              {total === 1 ? 'project' : 'projects'} in{' '}
              <span className={styles.summaryFigure}>{sessionCount}</span>{' '}
              {sessionCount === 1 ? 'session' : 'sessions'}
              {filtered && ' (filtered)'}
            </span>
            {bookings.isFetching && (
              <span className={styles.staleDot} aria-live="polite">
                Checking for changes…
              </span>
            )}
          </>
        )}

        {/*
          * A reading control, so it sits with the counts on the left rather than
          * with the exports on the right. Only where there is a table to fold:
          * the phone agenda has its own session sheets.
          */}
        {!isCompact && days.length > 0 && (
          <Button
            variant="ghost"
            size="small"
            icon={allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            onClick={toggleAll}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
        )}

        <span className={styles.summarySpacer} />

        <div className={styles.exportGroup}>
          {/*
            * Import belongs beside Export, not in the navigation: it is an
            * action on the plan you are looking at, and it fills the month the
            * export would have emptied.
            */}
          {canBook && (
            <Button
              variant="secondary"
              size="small"
              icon={<Upload size={13} />}
              onClick={() => setImporting(true)}
            >
              Import Plan
            </Button>
          )}
          <Button
            variant="ghost"
            size="small"
            icon={<FileSpreadsheet size={13} />}
            loading={exporting === 'excel'}
            onClick={() => void runExport('excel')}
          >
            Excel
          </Button>
          <Button
            variant="ghost"
            size="small"
            icon={<FileText size={13} />}
            loading={exporting === 'pdf'}
            onClick={() => void runExport('pdf')}
          >
            PDF
          </Button>
        </div>
      </div>

      <div className={styles.scroll}>
        {bookings.isError ? (
          <div className={styles.errorPanel} role="alert">
            <p className={styles.errorTitle}>The plan could not be loaded</p>
            <p className={styles.errorBody}>
              {bookings.error instanceof ApiError
                ? bookings.error.message
                : 'Something went wrong reaching the server.'}
            </p>
            <Button variant="secondary" onClick={() => void bookings.refetch()}>
              Try again
            </Button>
          </div>
        ) : bookings.isPending ? (
          isCompact ? <PlanAgendaSkeleton /> : <PlanTableSkeleton columns={columns} />
        ) : days.length === 0 ? (
          <EmptyState
            icon={<CalendarPlus size={26} strokeWidth={1.5} />}
            title={
              day
                ? `Nothing booked on ${formatDayHeading(day)}`
                : filtered
                  ? 'Nothing matches these filters'
                  : `No bookings in ${formatMonth(month)}`
            }
            body={
              day
                ? 'That day is free. Choose another day, or show the whole month.'
                : filtered
                ? 'Try a different committee, status or search term, or clear the filters to see the whole month.'
                : canBook
                  ? 'Book a committee slot to start this month. You can also plan into a future month using the arrows above.'
                  : 'When a Project Engineer books a slot for this month, it will appear here.'
            }
            action={
              day ? (
                <Button variant="secondary" onClick={() => setParam('day', null)}>
                  Show the whole month
                </Button>
              ) : filtered ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : canBook ? (
                <Button
                  variant="primary"
                  icon={<CalendarPlus size={14} />}
                  onClick={() => startBooking()}
                >
                  Book Committee Slot
                </Button>
              ) : undefined
            }
          />
        ) : isCompact ? (
          <PlanAgenda
            days={days}
            todayIso={today}
            selectedBookingId={focusedBookingId}
            recentlyChangedId={recentlyChangedId}
            onOpenBooking={openDetail}
            onOpenSession={(committeeSession) => setParam('session', committeeSession.key)}
          />
        ) : (
          <PlanTable
            key={month}
            days={days}
            columns={columns}
            todayIso={today}
            selectedBookingId={focusedBookingId}
            recentlyChangedId={recentlyChangedId}
            canBook={canBook}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onOpenBooking={openDetail}
            onAddToSession={addToSession}
          />
        )}
      </div>

      {importing && (
        <ImportDrawer
          onClose={() => setImporting(false)}
          onImported={setMonth}
        />
      )}

      {filtersOpen && (
        <PlanFilterSheet
          filters={{ day: day ?? '', committee, status, projectEngineer, onlyMine, includeCancelled, showPastDays }}
          facets={facets}
          dayOptions={visibleDays.map((entry) => ({
            date: entry.date,
            label: `${formatDayHeading(entry.date)} · ${entry.weekday}`,
          }))}
          canFilterMine={Boolean(user)}
          canShowPastDays={currentMonth}
          onApply={applyFilters}
          onClose={() => setFiltersOpen(false)}
        />
      )}

      {openSession && (
        <SessionSheet
          session={openSession}
          canBook={canBook}
          selectedBookingId={focusedBookingId}
          onClose={() => setParam('session', null)}
          onOpenBooking={(booking) => {
            setParam('session', null);
            openDetail(booking);
          }}
          onAddToSession={() => {
            addToSession(openSession);
            setParam('session', null);
          }}
        />
      )}

      {composing && (
        <BookingDrawer
          open
          mode="create"
          prefill={composing.prefill}
          month={month}
          onClose={() => setComposing(null)}
          onSaved={(booking) => {
            setComposing(null);
            markChanged(booking);
            // A booking created in another month should not silently vanish.
            if (booking.bookingDate.slice(0, 7) !== month) {
              setMonth(booking.bookingDate.slice(0, 7));
            }
          }}
        />
      )}

      {focusedBookingId && (
        <BookingDetailDrawer
          bookingId={focusedBookingId}
          onClose={closeDetail}
          onChanged={markChanged}
        />
      )}
    </div>
  );
}

/**
 * Which day of the month to read.
 *
 * Only days the month actually has bookings on are offered: a dropdown of all
 * 31 numbers would mostly be dead options, and choosing one would answer a
 * question the plan can already answer — the day is not there.
 */
function DaySelect({
  value,
  days,
  onChange,
}: {
  value: string | null;
  days: PlanDay[];
  onChange: (value: string | null) => void;
}) {
  const disabled = days.length === 0;

  return (
    <select
      className={styles.selectFilter}
      data-active={value !== null}
      value={value ?? ''}
      disabled={disabled}
      aria-label="Filter by day of the month"
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{disabled ? 'No days booked' : 'Day: all'}</option>
      {days.map((day) => (
        <option key={day.date} value={day.date}>
          {formatDayHeading(day.date)} · {day.weekday}
        </option>
      ))}
      {/*
        * A day carried in from a link may have been filtered out of the month
        * by a committee or search term. Keeping it listed means the control
        * still shows what the plan is actually showing.
        */}
      {value !== null && !days.some((day) => day.date === value) && (
        <option value={value}>{formatDayHeading(value)}</option>
      )}
    </select>
  );
}

/** A `YYYY-MM-DD` that belongs to the month being viewed, or null. */
function dayInMonth(raw: string | null, month: string): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw.slice(0, 7) === month ? raw : null;
}

function FacetSelect({
  label,
  value,
  options,
  labelFor,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  /** How an option reads, where the stored value is not what a person calls it. */
  labelFor?: (value: string) => string;
  onChange: (value: string | null) => void;
}) {
  // A facet the current month has no values for would be a dead control.
  const disabled = options.length === 0 && value === '';

  return (
    <select
      className={cn(styles.selectFilter)}
      data-active={value !== ''}
      value={value}
      disabled={disabled}
      aria-label={`Filter by ${label.toLowerCase()}`}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{disabled ? `No ${label.toLowerCase()}` : `${label}: all`}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {labelFor ? labelFor(option) : option}
        </option>
      ))}
      {value !== '' && !options.includes(value) && (
        <option value={value}>{labelFor ? labelFor(value) : value}</option>
      )}
    </select>
  );
}
