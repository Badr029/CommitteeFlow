import { Fragment } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { Booking, PlanField } from '@shared/api-types';
import { EMPTY, bookingValue, displayValue, formatDayHeading } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { statusLabel, toneForStatus } from '@/lib/status';
import { Skeleton } from '@/components/ui/Skeleton';
import { gridTemplate, type CommitteeSession, type PlanDay } from './sessions';
import styles from './PlanPage.module.css';

/**
 * The plan itself.
 *
 * Every column, label and order comes from Plan Configuration — there is no
 * hardcoded column list here (spec §35, §77). Date, Time and Committee are the
 * grouping, so they head the day and the session rather than repeating on rows.
 *
 * The three levels are drawn at three deliberately different weights: a day is
 * a bounded box with an accent heading, a session is a band inside it, and a
 * project is a hairline row. Reading a busy month should never mean working out
 * which of the three a line belongs to.
 *
 * Both levels minimise. Collapsing is view state, not plan state, so it is held
 * here rather than in the URL — which days someone folded away while reading is
 * not something they would want to send to a colleague.
 */
export function PlanTable({
  days,
  columns,
  todayIso,
  selectedBookingId,
  recentlyChangedId,
  canBook,
  collapsed,
  onToggleCollapsed,
  onOpenBooking,
  onAddToSession,
}: {
  days: PlanDay[];
  columns: PlanField[];
  todayIso: string;
  selectedBookingId: string | null;
  recentlyChangedId: string | null;
  canBook: boolean;
  /**
   * Which days and sessions are folded, keyed by day date and session key.
   *
   * Held by the page rather than here, because "collapse all" is a control in
   * the summary strip and the two have to agree about what is folded.
   */
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  onOpenBooking: (booking: Booking) => void;
  onAddToSession: (session: CommitteeSession) => void;
}) {
  const template = gridTemplate(columns);
  const toggle = onToggleCollapsed;

  return (
    <div className={styles.grid} role="table" aria-label="Committee Plan">
      <div className={styles.colHead} style={{ gridTemplateColumns: template }} role="row">
        {columns.map((field) => (
          <span
            key={field.fieldKey}
            role="columnheader"
            className={cn(field.fieldType === 'NUMBER' && styles.colHeadNumeric)}
          >
            {field.label}
          </span>
        ))}
      </div>

      <div className={styles.days}>
        {days.map((day) => {
          const dayCollapsed = collapsed.has(day.date);
          const bodyId = `plan-day-${day.date}`;
          const heading = formatDayHeading(day.date);

          return (
            <section key={day.date} className={styles.day}>
              <h2 className={styles.dayHead}>
                <button
                  type="button"
                  className={styles.disclosure}
                  onClick={() => toggle(day.date)}
                  aria-expanded={!dayCollapsed}
                  aria-controls={bodyId}
                  aria-label={dayCollapsed ? `Expand ${heading}` : `Minimise ${heading}`}
                >
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn(styles.chevron, dayCollapsed && styles.chevronCollapsed)}
                  />
                </button>
                <span>{heading}</span>
                <span className={styles.dayWeekday}>{day.weekday}</span>
                {day.date === todayIso && (
                  <Pill tone="accent" className={styles.todayPill} title="Today">
                    Today
                  </Pill>
                )}
                <span className={styles.dayCount}>
                  {day.sessions.length} {day.sessions.length === 1 ? 'session' : 'sessions'} ·{' '}
                  {day.bookingCount} {day.bookingCount === 1 ? 'project' : 'projects'}
                </span>
              </h2>

              {/*
                * Hidden rather than unmounted: reopening a day restores exactly
                * the sessions the reader left folded, instead of resetting them.
                */}
              <div className={styles.dayBody} id={bodyId} hidden={dayCollapsed}>
                {day.sessions.map((session) => {
                  const sessionCollapsed = collapsed.has(session.key);
                  const sessionBodyId = `plan-session-${session.key}`;

                  return (
                    <div key={session.key} className={styles.session}>
                      <SessionHeading
                        session={session}
                        collapsed={sessionCollapsed}
                        bodyId={sessionBodyId}
                        onToggle={() => toggle(session.key)}
                        canBook={canBook}
                        onAdd={() => onAddToSession(session)}
                      />

                      <div
                        className={styles.sessionBody}
                        id={sessionBodyId}
                        hidden={sessionCollapsed}
                      >
                        {session.bookings.map((booking) => (
                          <BookingRow
                            key={booking.id}
                            booking={booking}
                            columns={columns}
                            template={template}
                            selected={booking.id === selectedBookingId}
                            changed={booking.id === recentlyChangedId}
                            onOpen={() => onOpenBooking(booking)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SessionHeading({
  session,
  collapsed,
  bodyId,
  onToggle,
  canBook,
  onAdd,
}: {
  session: CommitteeSession;
  collapsed: boolean;
  bodyId: string;
  onToggle: () => void;
  canBook: boolean;
  onAdd: () => void;
}) {
  const count = session.bookings.length;
  const name = `${session.bookingTime} ${session.committee ?? 'No committee'}`;

  return (
    <div className={styles.sessionHead}>
      <button
        type="button"
        className={styles.disclosure}
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        aria-label={collapsed ? `Expand ${name}` : `Minimise ${name}`}
      >
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={cn(styles.chevron, collapsed && styles.chevronCollapsed)}
        />
      </button>
      <span className={styles.sessionTime}>{session.bookingTime}</span>
      <span className={styles.sessionDot} aria-hidden="true">
        ·
      </span>
      <span className={styles.sessionCommittee}>{session.committee ?? 'No committee'}</span>
      <span className={styles.sessionCount}>
        {count} {count === 1 ? 'project' : 'projects'}
      </span>
      <span className={styles.sessionSpacer} />
      {canBook && (
        <Button
          variant="linkish"
          size="small"
          className={styles.sessionAdd}
          icon={<Plus size={13} />}
          onClick={onAdd}
        >
          Add to this session
        </Button>
      )}
    </div>
  );
}

function BookingRow({
  booking,
  columns,
  template,
  selected,
  changed,
  onOpen,
}: {
  booking: Booking;
  columns: PlanField[];
  template: string;
  selected: boolean;
  changed: boolean;
  onOpen: () => void;
}) {
  const cancelled = booking.status === 'CANCELLED';

  return (
    <button
      type="button"
      role="row"
      onClick={onOpen}
      style={{ gridTemplateColumns: template }}
      className={cn(
        styles.row,
        selected && styles.rowSelected,
        cancelled && styles.rowCancelled,
        changed && styles.rowChanged,
      )}
      aria-label={`Open booking ${booking.offNo ?? booking.orderName ?? ''}`}
    >
      {columns.map((field) => (
        <Fragment key={field.fieldKey}>
          <Cell booking={booking} field={field} />
        </Fragment>
      ))}
    </button>
  );
}

function Cell({ booking, field }: { booking: Booking; field: PlanField }) {
  const raw = bookingValue(booking, field.fieldKey);

  /*
   * Status is the lifecycle, so it is always one of two values and never blank.
   * Cancelled reads as a warning rather than an error: the booking is on the
   * plan deliberately, so people can see the committee is not coming.
   */
  if (field.fieldKey === 'status') {
    return (
      <span role="cell" className={styles.cell}>
        <Pill tone={toneForStatus(booking.status)}>{statusLabel(booking.status)}</Pill>
      </span>
    );
  }

  // The engineer whose project this is. A booking imported from a sheet that
  // named nobody has none, and says so rather than guessing.
  if (field.fieldKey === 'project_engineer') {
    return (
      <span
        role="cell"
        title={booking.projectEngineer?.name ?? undefined}
        className={cn(
          styles.cell,
          styles.cellMuted,
          booking.projectEngineer === null && styles.cellEmpty,
        )}
      >
        {booking.projectEngineer?.name ?? EMPTY}
      </span>
    );
  }

  const text = displayValue(field, raw);
  const isEmpty = text === EMPTY;

  return (
    <span
      role="cell"
      title={isEmpty ? undefined : text}
      className={cn(
        styles.cell,
        field.fieldKey === 'off_no' && styles.cellKey,
        field.fieldKey === 'order_name' && styles.cellStrong,
        field.fieldType === 'NUMBER' && styles.cellNumeric,
        field.fieldKey === 'notes' && styles.cellMuted,
        field.fieldKey === 'customer_name' && styles.cellMuted,
        isEmpty && styles.cellEmpty,
      )}
    >
      {text}
    </span>
  );
}

/**
 * Loading state.
 *
 * A skeleton of the plan's own shape — day headings, session headings and rows
 * at their real heights — so nothing shifts when the data arrives.
 */
export function PlanTableSkeleton({ columns }: { columns: PlanField[] }) {
  const template = gridTemplate(columns.length > 0 ? columns : PLACEHOLDER_COLUMNS);
  const shape = columns.length > 0 ? columns : PLACEHOLDER_COLUMNS;

  return (
    <div className={styles.grid} aria-busy="true" aria-label="Loading the plan">
      <div className={styles.colHead} style={{ gridTemplateColumns: template }}>
        {shape.map((field) => (
          <span key={field.fieldKey}>{field.label}</span>
        ))}
      </div>

      <div className={styles.days}>
      {[3, 2, 3].map((sessionCount, dayIndex) => (
        <div key={dayIndex} className={styles.skeletonDay}>
          <div className={styles.dayHead}>
            <Skeleton width={112} height={13} />
            <Skeleton width={72} height={12} />
          </div>

          {Array.from({ length: sessionCount }, (_, sessionIndex) => (
            <div key={sessionIndex} className={styles.session}>
              <div className={styles.sessionHead}>
                <Skeleton width={42} height={13} />
                <Skeleton width={128} height={12} />
                <Skeleton width={64} height={12} />
              </div>
              {Array.from({ length: (sessionIndex % 2) + 1 }, (_, rowIndex) => (
                <div
                  key={rowIndex}
                  className={styles.skeletonRow}
                  style={{ gridTemplateColumns: template }}
                >
                  {shape.map((field, cellIndex) => (
                    <Skeleton
                      key={field.fieldKey}
                      height={11}
                      width={cellIndex % 3 === 0 ? '72%' : cellIndex % 3 === 1 ? '88%' : '54%'}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
      </div>
    </div>
  );
}

/**
 * Column shape used before the real configuration has loaded.
 *
 * Mirrors the seeded plan, so the very first paint is already close to the
 * layout that lands a moment later.
 */
const PLACEHOLDER_COLUMNS = [
  { fieldKey: 'off_no', label: 'OFF No.', fieldType: 'TEXT', displayOrder: 30 },
  { fieldKey: 'order_name', label: 'Order Name', fieldType: 'TEXT', displayOrder: 40 },
  { fieldKey: 'qty', label: 'Qty', fieldType: 'NUMBER', displayOrder: 60 },
  { fieldKey: 'kva', label: 'KVA', fieldType: 'NUMBER', displayOrder: 70 },
  { fieldKey: 'kv', label: 'KV', fieldType: 'TEXT', displayOrder: 80 },
  { fieldKey: 'status', label: 'Status', fieldType: 'TEXT', displayOrder: 90 },
  { fieldKey: 'notes', label: 'Notes', fieldType: 'LONG_TEXT', displayOrder: 100 },
  { fieldKey: 'customer_name', label: 'Customer Name', fieldType: 'TEXT', displayOrder: 110 },
] as unknown as PlanField[];

export { PLACEHOLDER_COLUMNS };
