import { CalendarPlus, ChevronRight, Users } from 'lucide-react';
import type { Booking } from '@shared/api-types';
import { EMPTY, formatDateCompact, weekdayOf } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { drawerFootSpacer } from '@/components/ui/classes';
import { Pill } from '@/components/ui/Pill';
import { toneForStatus } from '@/lib/status';
import type { CommitteeSession } from './sessions';
import styles from './PlanAgenda.module.css';

/**
 * One committee session, opened from the agenda.
 *
 * The confirmed rule (spec §46, §78.1) is that Date + Time + Committee is a
 * shared sitting, not a slot one project owns. This screen is that rule made
 * visible: the committee and the time at the top, every project under it, and
 * an action that adds another — with the schedule already filled in, because
 * the engineer chose it by opening this session.
 */
export function SessionSheet({
  session,
  canBook,
  selectedBookingId,
  onClose,
  onOpenBooking,
  onAddToSession,
}: {
  session: CommitteeSession;
  canBook: boolean;
  selectedBookingId: string | null;
  onClose: () => void;
  onOpenBooking: (booking: Booking) => void;
  onAddToSession: () => void;
}) {
  const count = session.bookings.length;
  const committee = session.committee ?? 'No committee';
  const active = session.bookings.filter((b) => b.status !== 'CANCELLED').length;

  return (
    <Drawer
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={committee}
      subtitle={
        <span>
          {weekdayOf(session.bookingDate)} {formatDateCompact(session.bookingDate)} ·{' '}
          {session.bookingTime}
        </span>
      }
      footer={
        canBook ? (
          <>
            <span className={drawerFootSpacer} />
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" icon={<CalendarPlus size={15} />} onClick={onAddToSession}>
              Add project
            </Button>
          </>
        ) : (
          <>
            <span className={drawerFootSpacer} />
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      <div className={styles.sessionSheet}>
        <div className={styles.sessionSummary}>
          <Users size={16} aria-hidden="true" className={styles.sessionSummaryIcon} />
          <span className={styles.sessionSummaryText}>
            <strong>
              {count} {count === 1 ? 'project' : 'projects'}
            </strong>{' '}
            in this session
            {active !== count && ` · ${count - active} cancelled`}
          </span>
        </div>

        <ul className={styles.sheetProjects}>
          {session.bookings.map((booking) => {
            const cancelled = booking.status === 'CANCELLED';
            return (
              <li key={booking.id}>
                <button
                  type="button"
                  onClick={() => onOpenBooking(booking)}
                  className={cn(
                    styles.sheetProject,
                    booking.id === selectedBookingId && styles.projectSelected,
                    cancelled && styles.projectCancelled,
                  )}
                >
                  <span className={styles.projectMain}>
                    <span className={styles.projectTop}>
                      <span className={styles.projectKey}>{booking.offNo ?? EMPTY}</span>
                      {cancelled ? (
                        <Pill tone="danger">Cancelled</Pill>
                      ) : booking.status ? (
                        <Pill tone={toneForStatus(booking.status)}>{booking.status}</Pill>
                      ) : null}
                    </span>
                    <span className={styles.projectName}>
                      {booking.orderName ?? 'Untitled order'}
                    </span>
                    {booking.customerName && (
                      <span className={styles.projectCustomer}>{booking.customerName}</span>
                    )}
                    <span className={styles.sheetProjectWho}>
                      Booked by {booking.createdBy.name}
                    </span>
                  </span>
                  <ChevronRight size={15} className={styles.projectChevron} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>

        {canBook && (
          <p className={styles.sessionNote}>
            Adding another project to this session is normal — a committee reviews several in one
            sitting. The date, time and committee are filled in for you.
          </p>
        )}
      </div>
    </Drawer>
  );
}
