import { useState } from 'react';
import { toast } from 'sonner';
import { Ban, Eye, History, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Booking, BookingHistoryEntry, PlanField } from '@shared/api-types';
import { ApiError } from '@/api/client';
import {
  useBooking,
  useBookingHistory,
  useCancelBooking,
  useDeleteBooking,
  usePlanFields,
  useSession,
} from '@/api/queries';
import { cn } from '@/lib/cn';
import {
  EMPTY,
  bookingValue,
  displayValue,
  formatDateCompact,
  formatRelative,
  formatTimestamp,
} from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Drawer } from '@/components/ui/Drawer';
import { drawerFootSpacer } from '@/components/ui/classes';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { statusLabel, toneForStatus } from '@/lib/status';
import { Skeleton } from '@/components/ui/Skeleton';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
import { useIsCompact } from '@/lib/viewport';
import { GROUPED_KEYS } from '@/features/plan/sessions';
import { BookingDrawer } from './BookingDrawer';
import styles from './booking.module.css';

/**
 * Booking details (spec §12).
 *
 * Shows the configured business fields, who owns the booking, when it changed
 * and what changed — the difference between "someone edited the spreadsheet"
 * and a traceable operation.
 */
export function BookingDetailDrawer({
  bookingId,
  onClose,
  onChanged,
}: {
  bookingId: string;
  onClose: () => void;
  onChanged: (booking: Booking) => void;
}) {
  const session = useSession();
  const planFields = usePlanFields();
  const booking = useBooking(bookingId);
  const history = useBookingHistory(bookingId);
  const cancel = useCancelBooking();
  const remove = useDeleteBooking();

  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const compact = useIsCompact();

  const canEdit =
    (session.data?.user.permissions.canCreateBooking ?? false) &&
    booking.data?.status === 'PLANNED';

  /*
   * Deleting stays available on a cancelled booking. The two answer different
   * questions — "this committee is not coming" and "this row should not exist"
   * — and a booking entered by mistake and then cancelled was still entered by
   * mistake.
   */
  const canDelete = session.data?.user.permissions.canCreateBooking ?? false;

  const deleteBooking = () => {
    if (!booking.data) return;
    remove.mutate(
      { id: booking.data.id, version: booking.data.version },
      {
        onSuccess: () => {
          setConfirmDelete(false);
          toast.success('Booking deleted', {
            description: 'It has left the plan. The history still records who removed it.',
          });
          onClose();
        },
        onError: (error) => {
          toast.error(
            error instanceof ApiError ? error.message : 'That booking could not be deleted.',
          );
        },
      },
    );
  };

  const cancelBooking = () => {
    if (!booking.data) return;
    cancel.mutate(
      {
        id: booking.data.id,
        version: booking.data.version,
        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}),
      },
      {
        onSuccess: (updated) => {
          setConfirmCancel(false);
          setCancelReason('');
          toast.success('Booking cancelled', {
            description: 'It stays in the plan history and everyone is notified.',
          });
          onChanged(updated);
        },
        onError: (error) => {
          setConfirmCancel(false);
          if (error instanceof ApiError && error.isVersionConflict) {
            toast.error(error.message, {
              action: { label: 'Refresh', onClick: () => void booking.refetch() },
            });
            return;
          }
          toast.error(
            error instanceof ApiError ? error.message : 'The booking could not be cancelled.',
          );
        },
      },
    );
  };

  const data = booking.data;

  return (
    <>
      <Drawer
        open={!editing}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        wide
        title={data ? (data.offNo ?? data.orderName ?? 'Booking') : 'Booking'}
        subtitle={
          data ? (
            <span>
              {data.displayDay} {formatDateCompact(data.bookingDate)} · {data.bookingTime} ·{' '}
              {data.committee ?? 'No committee'}
            </span>
          ) : undefined
        }
        footer={
          <>
            {data?.status === 'CANCELLED' && (
              <span className={styles.readOnlyNote}>
                <Ban size={13} aria-hidden="true" />
                Cancelled bookings are read-only.
              </span>
            )}
            {!session.data?.user.permissions.canCreateBooking && (
              <span className={styles.readOnlyNote}>
                <Eye size={13} aria-hidden="true" />
                You have read-only access to the plan.
              </span>
            )}
            <span className={drawerFootSpacer} />
            {!compact && (
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
            {/*
              * Delete sits apart from Cancel, and quieter.
              *
              * Cancelling is the ordinary thing to do when a committee is no
              * longer coming, and deleting is the rare correction for a row
              * that should never have existed. Giving them equal weight side by
              * side would invite the destructive one by mistake — so this is a
              * ghost button, first in the row and visually the least of the
              * three.
              */}
            {canDelete && (
              <Button
                variant="ghost"
                icon={<Trash2 size={14} />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
            {canEdit && (
              <>
                <Button
                  variant="secondary"
                  icon={<Ban size={14} />}
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel booking
                </Button>
                <Button variant="primary" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </>
            )}
          </>
        }
      >
        {booking.isPending || planFields.isPending ? (
          <DetailSkeleton />
        ) : booking.isError || !data ? (
          <EmptyState
            title="This booking could not be loaded"
            body={
              booking.error instanceof ApiError
                ? booking.error.message
                : 'It may have been removed, or the server is unreachable.'
            }
            action={
              <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void booking.refetch()}>
                Try again
              </Button>
            }
          />
        ) : (
          <div className={styles.detail}>
            {data.status === 'CANCELLED' && (
              <div className={`${styles.banner} ${styles.bannerWarn}`}>
                <Ban size={15} className={styles.bannerIcon} aria-hidden="true" />
                <div className={styles.bannerBody}>
                  <span className={styles.bannerTitle}>
                    Cancelled by {data.cancelledBy?.name ?? 'someone'}
                    {data.cancelledAt ? ` · ${formatTimestamp(data.cancelledAt)}` : ''}
                  </span>
                  {data.cancellationReason && <span>{data.cancellationReason}</span>}
                </div>
              </div>
            )}

            <FieldSection booking={data} fields={planFields.data ?? []} omitGrouped={compact} />
            <OwnershipSection booking={data} />
            <HistorySection
              entries={history.data}
              loading={history.isPending}
              onRetry={() => void history.refetch()}
            />
          </div>
        )}
      </Drawer>

      {editing && data && (
        <BookingDrawer
          open
          mode="edit"
          booking={data}
          onRefresh={() => void booking.refetch()}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            onChanged(updated);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={(open) => {
          setConfirmCancel(open);
          if (!open) setCancelReason('');
        }}
        title="Cancel this booking?"
        description="It is removed from the active plan but kept in history, and everyone on the plan is notified. It cannot be edited afterwards."
        confirmLabel="Cancel booking"
        cancelLabel="Keep booking"
        destructive
        loading={cancel.isPending}
        onConfirm={cancelBooking}
      >
        <Field label="Reason" showOptional help="Shown in the history and the notification email.">
          {(props) => (
            <input
              {...props}
              className={controlClass}
              type="text"
              maxLength={1000}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              placeholder="Customer postponed"
            />
          )}
        </Field>
      </ConfirmDialog>

      {/*
        * A stronger confirmation than cancelling, because it is the less
        * common action and the one people reach for by mistake. It says which
        * of the two they probably want rather than only warning them.
        */}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this booking?"
        description={
          <>
            Use Delete only when this booking was added by mistake — a duplicate, or the wrong
            project. If it was genuinely planned and is no longer happening, cancel it instead so it
            stays visible on the plan.
            <br />
            <br />
            This booking will be removed from the plan. Its history is kept.
          </>
        }
        confirmLabel="Delete booking"
        cancelLabel="Keep booking"
        destructive
        loading={remove.isPending}
        onConfirm={deleteBooking}
      />
    </>
  );
}

/** The configured business fields, in their configured order (spec §35). */
function FieldSection({
  booking,
  fields,
  omitGrouped,
}: {
  booking: Booking;
  fields: PlanField[];
  /*
   * On a narrow screen the sheet's own header already reads
   * "Thursday 10 Sep 2026 · 10:00 · South Committee", so repeating date, time
   * and committee as the first three rows costs a third of the first screen and
   * says nothing new. Same reasoning, and the same key list, as the plan table
   * excluding them because they head the group.
   */
  omitGrouped: boolean;
}) {
  const visible = fields
    .filter((field) => {
      if (omitGrouped && GROUPED_KEYS.has(field.fieldKey)) return false;
      if (!field.isVisible) return false;
      // An archived field still shows when this booking holds a value for it,
      // so history never loses meaning (spec §23).
      if (!field.isActive) {
        const value = bookingValue(booking, field.fieldKey);
        return value !== null && value !== undefined && value !== '';
      }
      return true;
    })
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Booking</h3>
      <dl className={styles.definitionList}>
        {visible.map((field) => {
          const raw = bookingValue(booking, field.fieldKey);
          const text = displayValue(field, raw);
          const isEmpty = text === EMPTY;

          return (
            <div key={field.fieldKey} style={{ display: 'contents' }}>
              <dt className={styles.term}>
                {field.label}
                {!field.isActive && ' (archived)'}
              </dt>
              <dd
                className={cn(
                  styles.definition,
                  isEmpty && styles.definitionEmpty,
                  field.fieldType === 'LONG_TEXT' && styles.definitionMultiline,
                )}
              >
                {field.fieldKey === 'status' ? (
                  <Pill tone={toneForStatus(booking.status)}>{statusLabel(booking.status)}</Pill>
                ) : field.fieldKey === 'project_engineer' ? (
                  (booking.projectEngineer?.name ?? text)
                ) : (
                  text
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/** Who created it, who last changed it, and when (spec §12). */
function OwnershipSection({ booking }: { booking: Booking }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Ownership</h3>
      <div className={styles.ownership}>
        <div className={styles.ownershipCell}>
          <span className={styles.ownershipLabel}>Created by</span>
          <span className={styles.ownershipWho}>{booking.createdBy.name}</span>
          <span className={styles.ownershipWhen} title={booking.createdAt}>
            {formatTimestamp(booking.createdAt)}
          </span>
        </div>
        <div className={styles.ownershipCell}>
          <span className={styles.ownershipLabel}>Last updated by</span>
          <span className={styles.ownershipWho}>{booking.updatedBy.name}</span>
          <span className={styles.ownershipWhen} title={booking.updatedAt}>
            {formatTimestamp(booking.updatedAt)} · {formatRelative(booking.updatedAt)}
          </span>
        </div>
      </div>
    </section>
  );
}

/** What changed, from what, to what, by whom (spec §13). */
function HistorySection({
  entries,
  loading,
  onRetry,
}: {
  entries: BookingHistoryEntry[] | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <History size={13} aria-hidden="true" />
        History
      </h3>

      {loading ? (
        <div className={styles.history} aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className={styles.historyEntry}>
              <Skeleton width={22} height={22} />
              <div className={styles.historyBody}>
                <Skeleton width={index === 0 ? 210 : 168} height={11} />
                <Skeleton width={index === 1 ? 260 : 132} height={10} />
              </div>
            </div>
          ))}
        </div>
      ) : !entries ? (
        <EmptyState
          title="History could not be loaded"
          action={
            <Button variant="secondary" size="small" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className={styles.history}>
          {entries.map((entry) => (
            <article key={entry.id} className={styles.historyEntry}>
              <span
                className={cn(
                  styles.historyMarker,
                  entry.action === 'CREATE' && styles.historyMarkerCreate,
                  entry.action === 'CANCEL' && styles.historyMarkerCancel,
                )}
                aria-hidden="true"
              >
                {entry.action === 'CREATE' ? (
                  <Plus size={12} />
                ) : entry.action === 'CANCEL' ? (
                  <Ban size={12} />
                ) : (
                  <Pencil size={12} />
                )}
              </span>

              <div className={styles.historyBody}>
                <div className={styles.historyHead}>
                  <span className={styles.historyActor}>{entry.actor?.name ?? 'Someone'}</span>
                  <span>
                    {entry.action === 'CREATE'
                      ? 'created this booking'
                      : entry.action === 'CANCEL'
                        ? 'cancelled this booking'
                        : 'made a change'}
                  </span>
                  <span className={styles.historyWhen} title={entry.createdAt}>
                    {formatTimestamp(entry.createdAt)}
                  </span>
                </div>

                {entry.action === 'UPDATE' && entry.changes.length > 0 && (
                  <div className={styles.changeList}>
                    {entry.changes.map((change) => (
                      <div key={change.fieldKey} className={styles.change}>
                        <span className={styles.changeLabel}>{change.label}</span>
                        <span className={styles.changeFrom}>{formatChange(change.from)}</span>
                        <span className={styles.changeArrow} aria-label="changed to">
                          →
                        </span>
                        <span className={styles.changeTo}>{formatChange(change.to)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function formatChange(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function DetailSkeleton() {
  return (
    <div className={styles.detail} aria-busy="true" aria-label="Loading the booking">
      <section className={styles.section}>
        <Skeleton width={78} height={9} />
        <dl className={styles.definitionList}>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} style={{ display: 'contents' }}>
              <dt>
                <Skeleton width={index % 2 === 0 ? 62 : 88} height={9} />
              </dt>
              <dd>
                <Skeleton width={index % 3 === 0 ? '48%' : '72%'} height={12} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section}>
        <Skeleton width={92} height={9} />
        <div className={styles.ownership}>
          {[0, 1].map((index) => (
            <div key={index} className={styles.ownershipCell}>
              <Skeleton width={74} height={9} />
              <Skeleton width={132} height={12} />
              <Skeleton width={168} height={10} />
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <Skeleton width={62} height={9} />
        <div className={styles.history}>
          {[0, 1].map((index) => (
            <div key={index} className={styles.historyEntry}>
              <Skeleton width={22} height={22} />
              <div className={styles.historyBody}>
                <Skeleton width={196} height={11} />
                <Skeleton width={148} height={10} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
