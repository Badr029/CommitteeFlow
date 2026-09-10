import { ChevronRight, UserRound } from 'lucide-react';
import type { Booking } from '@shared/api-types';
import { EMPTY, formatDayHeadingShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Pill } from '@/components/ui/Pill';
import { Skeleton } from '@/components/ui/Skeleton';
import { statusLabel, toneForStatus } from '@/lib/status';
import type { CommitteeSession, PlanDay } from './sessions';
import styles from './PlanAgenda.module.css';

/**
 * The Committee Plan on a phone or tablet.
 *
 * Same structure as the desktop table — Date → Session → projects — read down
 * the screen instead of across it. The table is not narrowed: at this width the
 * eight configured columns cannot be labelled, so the fields that identify a
 * booking are promoted and the engineering quantities move to the booking's own
 * screen (spec §9's priority order).
 *
 * A session is a band, not a card: one committee sitting once, with its projects
 * beneath it. Making each project a card of its own would say they are unrelated,
 * which is the opposite of the confirmed rule that a session is shared.
 */
export function PlanAgenda({
  days,
  todayIso,
  selectedBookingId,
  recentlyChangedId,
  onOpenBooking,
  onOpenSession,
}: {
  days: PlanDay[];
  todayIso: string;
  selectedBookingId: string | null;
  recentlyChangedId: string | null;
  onOpenBooking: (booking: Booking) => void;
  onOpenSession: (session: CommitteeSession) => void;
}) {
  return (
    <div className={styles.agenda}>
      {days.map((day) => (
        <section key={day.date} className={styles.day} aria-labelledby={`day-${day.date}`}>
          <h2
            id={`day-${day.date}`}
            className={cn(styles.dayHead, day.date === todayIso && styles.dayHeadToday)}
          >
            <span className={styles.dayName}>{formatDayHeadingShort(day.date)}</span>
            {day.date === todayIso && (
              <Pill tone="accent" className={styles.todayPill}>
                Today
              </Pill>
            )}
            <span className={styles.dayCount}>
              {day.sessions.length} {day.sessions.length === 1 ? 'session' : 'sessions'} ·{' '}
              {day.bookingCount} {day.bookingCount === 1 ? 'project' : 'projects'}
            </span>
          </h2>

          <div className={styles.sessions}>
            {day.sessions.map((session) => (
              <SessionGroup
                key={session.key}
                session={session}
                selectedBookingId={selectedBookingId}
                recentlyChangedId={recentlyChangedId}
                onOpenBooking={onOpenBooking}
                onOpenSession={() => onOpenSession(session)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SessionGroup({
  session,
  selectedBookingId,
  recentlyChangedId,
  onOpenBooking,
  onOpenSession,
}: {
  session: CommitteeSession;
  selectedBookingId: string | null;
  recentlyChangedId: string | null;
  onOpenBooking: (booking: Booking) => void;
  onOpenSession: () => void;
}) {
  const count = session.bookings.length;
  const committee = session.committee ?? 'No committee';

  return (
    <section className={styles.session}>
      {/*
       * The heading is the way into the session view, so it is the button —
       * rather than a separate "View session" link that would compete with the
       * project rows for the same tap.
       */}
      <button type="button" className={styles.sessionHead} onClick={onOpenSession}>
        <span className={styles.sessionTime}>{session.bookingTime}</span>
        <span className={styles.sessionCommittee}>{committee}</span>
        <span className={styles.sessionCount}>
          {count} {count === 1 ? 'project' : 'projects'}
        </span>
        <ChevronRight size={15} className={styles.sessionChevron} aria-hidden="true" />
        <span className="sr-only">
          View the {committee} session at {session.bookingTime}
        </span>
      </button>

      <ul className={styles.projects}>
        {session.bookings.map((booking) => (
          <li key={booking.id}>
            <ProjectRow
              booking={booking}
              selected={booking.id === selectedBookingId}
              changed={booking.id === recentlyChangedId}
              onOpen={() => onOpenBooking(booking)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One project inside a session.
 *
 * Carries only what identifies a booking at a glance: its OFF number, the order,
 * the customer, and its state. Quantities, voltages and notes are one tap away
 * on the booking itself — putting them here would triple the height of every row
 * and make the day unscannable, which is the thing the plan is for.
 */
function ProjectRow({
  booking,
  selected,
  changed,
  onOpen,
}: {
  booking: Booking;
  selected: boolean;
  changed: boolean;
  onOpen: () => void;
}) {
  const cancelled = booking.status === 'CANCELLED';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        styles.project,
        selected && styles.projectSelected,
        cancelled && styles.projectCancelled,
        changed && styles.projectChanged,
      )}
      aria-label={`Open booking ${booking.offNo ?? booking.orderName ?? 'details'}`}
    >
      <span className={styles.projectMain}>
        <span className={styles.projectTop}>
          <span className={styles.projectKey}>{booking.offNo ?? EMPTY}</span>
          {/*
            * Only cancelled bookings carry a pill on a phone card. Every other
            * booking is planned, so a "Planned" chip on every row would cost a
            * line of width to say nothing.
            */}
          {cancelled && <Pill tone={toneForStatus(booking.status)}>{statusLabel(booking.status)}</Pill>}
        </span>

        <span className={styles.projectName}>{booking.orderName ?? 'Untitled order'}</span>

        {/*
          * The customer and the engineer share a line rather than taking one
          * each. A phone card that grows a row per fact stops being scannable,
          * and both of these are secondary to the OFF number and the order.
          */}
        {(booking.customerName || booking.projectEngineer) && (
          <span className={styles.projectMeta}>
            {booking.customerName && (
              <span className={styles.projectCustomer}>{booking.customerName}</span>
            )}
            {booking.projectEngineer && (
              <span className={styles.projectEngineer}>
                <UserRound size={11} aria-hidden="true" />
                {booking.projectEngineer.name}
              </span>
            )}
          </span>
        )}
      </span>

      <ChevronRight size={15} className={styles.projectChevron} aria-hidden="true" />
    </button>
  );
}

/**
 * Loading state.
 *
 * The agenda's own shape at its real heights — day headings, session bands and
 * project rows — so the plan does not jump when the month arrives.
 */
export function PlanAgendaSkeleton() {
  return (
    <div className={styles.agenda} aria-busy="true" aria-label="Loading the plan">
      {[2, 1, 2].map((sessionCount, dayIndex) => (
        <section key={dayIndex} className={styles.day}>
          <div className={styles.dayHead}>
            <Skeleton width={132} height={12} />
            <Skeleton width={104} height={10} />
          </div>
          <div className={styles.sessions}>
            {Array.from({ length: sessionCount }, (_, sessionIndex) => (
              <div key={sessionIndex} className={styles.session}>
                <div className={styles.sessionHead}>
                  <Skeleton width={44} height={14} />
                  <Skeleton width={116} height={12} />
                  <Skeleton width={58} height={12} />
                </div>
                <ul className={styles.projects}>
                  {Array.from({ length: sessionIndex === 0 ? 3 : 1 }, (_, rowIndex) => (
                    <li key={rowIndex}>
                      <div className={styles.project}>
                        <span className={styles.projectMain}>
                          <span className={styles.projectTop}>
                            <Skeleton width={84} height={12} />
                            <Skeleton width={62} height={14} />
                          </span>
                          <Skeleton width={rowIndex % 2 === 0 ? '68%' : '52%'} height={12} />
                          <Skeleton width="40%" height={10} />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
