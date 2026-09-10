import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Info, RefreshCw, Users } from 'lucide-react';
import type { Booking, PlanField, PlanFieldValue } from '@shared/api-types';
import { ApiError } from '@/api/client';
import {
  useCreateBooking,
  usePlanFields,
  useSessionPreview,
  useUpdateBooking,
} from '@/api/queries';
import { bookingValue } from '@/lib/format';
import { firstDayOf } from '@/lib/months';
import { useIsCompact } from '@/lib/viewport';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Drawer } from '@/components/ui/Drawer';
import { drawerFootSpacer } from '@/components/ui/classes';
import { Skeleton } from '@/components/ui/Skeleton';
import { DynamicField } from './DynamicField';
import { groupFieldsIntoSections } from './sections';
import styles from './booking.module.css';

/**
 * Book Committee Slot — the product's primary action (spec §3).
 *
 * The form is generated entirely from Plan Configuration, so a renamed label, a
 * new custom field or a changed requiredness appears here with no code change.
 * The same component handles editing, because both are the same operation on
 * the same configured fields.
 */
export function BookingDrawer({
  open,
  mode,
  booking,
  prefill = {},
  month,
  onClose,
  onSaved,
  onRefresh,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  booking?: Booking;
  prefill?: Partial<Record<string, string>>;
  month?: string;
  onClose: () => void;
  onSaved: (booking: Booking) => void;
  /** Reloads the booking after someone else's edit made this one stale. */
  onRefresh?: () => void;
}) {
  const planFields = usePlanFields();
  const create = useCreateBooking();
  const update = useUpdateBooking();
  const mutation = mode === 'create' ? create : update;
  /*
   * Narrow screens get the form in sections. A desktop drawer shows the whole
   * two-column grid at once, where headings would be scaffolding around
   * something already legible.
   */
  const sectioned = useIsCompact();

  const fields = useMemo(
    () =>
      (planFields.data ?? [])
        .filter((field) => field.isActive && field.isVisible)
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [planFields.data],
  );

  const sections = useMemo(() => groupFieldsIntoSections(fields), [fields]);

  const [values, setValues] = useState<Record<string, PlanFieldValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [conflicted, setConflicted] = useState(false);

  // Seed the form once the configuration is known.
  useEffect(() => {
    if (fields.length === 0) return;
    const seeded: Record<string, PlanFieldValue> = {};
    for (const field of fields) {
      if (mode === 'edit' && booking) {
        seeded[field.fieldKey] = bookingValue(booking, field.fieldKey);
        continue;
      }
      const preset = prefill[field.fieldKey];
      if (preset !== undefined) {
        seeded[field.fieldKey] = preset;
      } else if (field.fieldKey === 'booking_date') {
        // Default to the month being viewed, so a future-month booking does not
        // silently land in today's month (spec §9).
        seeded[field.fieldKey] = month ? firstDayOf(month) : null;
      } else if (field.fieldType === 'CHECKBOX') {
        seeded[field.fieldKey] = false;
      } else {
        seeded[field.fieldKey] = null;
      }
    }
    setValues(seeded);
    setDirty(false);
    setFieldErrors({});
    setFormError(null);
    setConflicted(false);
    // `version` is in the list so that reloading a stale booking reseeds the
    // form with what is actually on the server, which is the whole point of
    // offering the reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.length, booking?.id, booking?.version, mode]);

  const setValue = (key: string, value: PlanFieldValue) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const sessionPreview = useSessionPreview(
    stringOrUndefined(values['booking_date']),
    stringOrUndefined(values['booking_time']),
    stringOrUndefined(values['committee']),
  );

  const submit = () => {
    setFieldErrors({});
    setFormError(null);
    setConflicted(false);

    const payload = buildPayload(fields, values, mode, booking);

    const handleError = (error: unknown) => {
      if (!(error instanceof ApiError)) {
        setFormError('Something went wrong. Try again.');
        return;
      }
      const byField = error.fieldErrors();
      setFieldErrors(byField);
      // Anything the form cannot attach to a visible field is shown at the top.
      const unattached = error.issues.filter(
        (issue) => !fields.some((field) => field.fieldKey === issue.field),
      );
      setFormError(
        unattached.length > 0 || Object.keys(byField).length === 0 ? error.message : null,
      );
      if (error.isVersionConflict) {
        setFormError(error.message);
        setConflicted(true);
      }
    };

    if (mode === 'create') {
      create.mutate(payload, {
        onSuccess: (saved) => {
          toast.success('Committee slot booked', {
            description: describeBooking(saved),
          });
          onSaved(saved);
        },
        onError: handleError,
      });
      return;
    }

    if (!booking) return;
    update.mutate(
      { id: booking.id, version: booking.version, values: payload },
      {
        onSuccess: (saved) => {
          toast.success('Booking updated', { description: describeBooking(saved) });
          onSaved(saved);
        },
        onError: handleError,
      },
    );
  };

  const requestClose = () => {
    if (mutation.isPending) return false;
    if (dirty) {
      setConfirmDiscard(true);
      return false;
    }
    return true;
  };

  const title = mode === 'create' ? 'Book Committee Slot' : 'Edit booking';

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        onRequestClose={requestClose}
        title={title}
        subtitle={
          mode === 'edit' && booking
            ? `${booking.offNo ?? 'Booking'} · version ${booking.version}`
            : 'Several projects can share one committee session.'
        }
        footer={
          <>
            <span className={styles.footNote}>
              {mode === 'create'
                ? 'Everyone on the plan is notified.'
                : 'The change is recorded in this booking’s history.'}
            </span>
            <span className={drawerFootSpacer} />
            <Button
              variant="ghost"
              onClick={() => {
                if (requestClose()) onClose();
              }}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              loading={mutation.isPending}
              disabled={planFields.isPending}
            >
              {mode === 'create' ? 'Book slot' : 'Save changes'}
            </Button>
          </>
        }
      >
        {planFields.isPending ? (
          <FormSkeleton />
        ) : (
          <div className={styles.form}>
            {formError && (
              <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
                <AlertTriangle size={15} className={styles.bannerIcon} aria-hidden="true" />
                <div className={styles.bannerBody}>
                  <span className={styles.bannerTitle}>This booking was not saved</span>
                  <span>{formError}</span>
                  {/*
                    * A conflict is the one error the user cannot fix by editing
                    * what they typed, so it is the one that has to carry its own
                    * way out. Reloading reseeds the form from the server.
                    */}
                  {conflicted && onRefresh && (
                    <span className={styles.bannerAction}>
                      <Button
                        variant="secondary"
                        size="small"
                        icon={<RefreshCw size={13} />}
                        onClick={() => {
                          setConflicted(false);
                          setFormError(null);
                          onRefresh();
                        }}
                      >
                        Refresh booking
                      </Button>
                    </span>
                  )}
                </div>
              </div>
            )}

            <SessionNotice
              preview={sessionPreview.data}
              loading={sessionPreview.isFetching}
              excludeBookingId={booking?.id}
            />

            {sectioned ? (
              sections.map((section) => (
                <section key={section.id} className={styles.formSection}>
                  <h3 className={styles.formSectionTitle}>{section.title}</h3>
                  {section.hint && <p className={styles.formSectionHint}>{section.hint}</p>}
                  <div className={styles.grid}>
                    {section.fields.map((field) => (
                      <DynamicField
                        key={field.fieldKey}
                        field={field}
                        value={values[field.fieldKey] ?? null}
                        error={fieldErrors[field.fieldKey]}
                        disabled={mutation.isPending}
                        onChange={(value) => setValue(field.fieldKey, value)}
                      />
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className={styles.grid}>
                {fields.map((field, index) => (
                  <DynamicField
                    key={field.fieldKey}
                    field={field}
                    value={values[field.fieldKey] ?? null}
                    error={fieldErrors[field.fieldKey]}
                    disabled={mutation.isPending}
                    autoFocus={index === 0 && mode === 'create'}
                    onChange={(value) => setValue(field.fieldKey, value)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this booking?"
        description="You have unsaved changes. Closing now will lose them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </>
  );
}

/**
 * What is already in this committee session.
 *
 * A shared session accepts any number of projects, so this is stated as fact,
 * never as a warning, and never disables the save button.
 */
function SessionNotice({
  preview,
  loading,
  excludeBookingId,
}: {
  preview: ReturnType<typeof useSessionPreview>['data'];
  loading: boolean;
  excludeBookingId?: string | undefined;
}) {
  if (loading && !preview) {
    return (
      <div className={styles.sessionNotice}>
        <Skeleton width={220} height={12} />
        <Skeleton width="100%" height={11} />
      </div>
    );
  }

  const others = (preview?.bookings ?? []).filter((entry) => entry.id !== excludeBookingId);
  if (!preview || others.length === 0) return null;

  return (
    <div className={styles.sessionNotice}>
      <div className={styles.sessionNoticeHead}>
        <Users size={14} aria-hidden="true" />
        <span className={styles.sessionNoticeTitle}>
          {others.length} {others.length === 1 ? 'project is' : 'projects are'} already in this
          session
        </span>
        <span>
          {preview.committee ?? 'No committee'} · {preview.bookingTime}
        </span>
      </div>

      <div className={styles.sessionList}>
        {others.slice(0, 6).map((entry) => (
          <div key={entry.id} className={styles.sessionItem}>
            <span className={styles.sessionItemKey}>{entry.offNo ?? '—'}</span>
            <span className={styles.sessionItemName}>{entry.orderName ?? 'Untitled order'}</span>
            <span className={styles.sessionItemWho}>{entry.createdBy.name}</span>
          </div>
        ))}
        {others.length > 6 && (
          <div className={styles.sessionItem}>
            <span className={styles.sessionItemWho}>and {others.length - 6} more</span>
          </div>
        )}
      </div>

      <div className={styles.sessionNoticeHead}>
        <Info size={13} aria-hidden="true" />
        <span>Adding another project to this session is normal.</span>
      </div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className={styles.form} aria-busy="true" aria-label="Loading the booking form">
      <div className={styles.grid}>
        {Array.from({ length: 10 }, (_, index) => (
          <div
            key={index}
            className={index === 3 || index === 8 ? styles.span2 : undefined}
            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <Skeleton width={index % 3 === 0 ? 64 : 84} height={9} />
            <Skeleton height={32} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Builds the write payload.
 *
 * On edit only changed keys are sent, so two people editing different fields of
 * the same booking do not overwrite each other's untouched values.
 */
function buildPayload(
  fields: PlanField[],
  values: Record<string, PlanFieldValue>,
  mode: 'create' | 'edit',
  booking?: Booking,
): Record<string, PlanFieldValue> {
  const payload: Record<string, PlanFieldValue> = {};

  for (const field of fields) {
    const value = normalize(values[field.fieldKey] ?? null);

    if (mode === 'create') {
      // Omit empties entirely so the server's "required" message is about the
      // field being missing, not about it being blank.
      if (value !== null) payload[field.fieldKey] = value;
      continue;
    }

    const previous = normalize(booking ? bookingValue(booking, field.fieldKey) : null);
    if (!sameValue(previous, value)) {
      payload[field.fieldKey] = value;
    }
  }

  return payload;
}

function normalize(value: PlanFieldValue): PlanFieldValue {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value ?? null;
}

function sameValue(a: PlanFieldValue, b: PlanFieldValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return String(a) === String(b);
}

function stringOrUndefined(value: PlanFieldValue | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value);
}

function describeBooking(booking: Booking): string {
  const parts = [booking.offNo, booking.committee, `${booking.displayDay} ${booking.bookingDate}`];
  return parts.filter(Boolean).join(' · ');
}
