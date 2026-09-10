import { toast } from 'sonner';
import type {
  BookingEditPolicy,
  NotificationAudience,
  SlotUniqueness,
} from '@shared/api-types';
import { ApiError } from '@/api/client';
import { useSettings, useUpdateSettings } from '@/api/queries';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
import { Skeleton } from '@/components/ui/Skeleton';
import styles from './PlanConfigPage.module.css';

/**
 * Business rules (spec §78, §79).
 *
 * The three rules the specification left open live here rather than in code, so
 * they can be confirmed or revised without a migration or a redeploy. Their
 * current values are the ones confirmed with the business; the alternatives
 * stay available because a plan's rules outlive any one decision.
 */

const SLOT_OPTIONS: Array<{ value: SlotUniqueness; label: string }> = [
  { value: 'NONE', label: 'Shared sessions — several projects per slot' },
  { value: 'DATE_TIME_COMMITTEE', label: 'One booking per date, time and committee' },
  { value: 'DATE_TIME', label: 'One booking per date and time' },
  { value: 'DATE', label: 'One booking per date' },
];

const EDIT_OPTIONS: Array<{ value: BookingEditPolicy; label: string }> = [
  { value: 'ANY_ENGINEER', label: 'Any Project Engineer' },
  { value: 'CREATOR_ONLY', label: 'Only the engineer who created it' },
  { value: 'CREATOR_OR_PLAN_MANAGER', label: 'The creator, or a plan manager' },
];

const AUDIENCE_OPTIONS: Array<{ value: NotificationAudience; label: string }> = [
  { value: 'ALL_ACTIVE_USERS', label: 'Everyone with an account' },
  { value: 'ENGINEERS_ONLY', label: 'Project Engineers only' },
];

const HORIZON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'No limit' },
  { value: '3', label: 'Up to 3 months ahead' },
  { value: '6', label: 'Up to 6 months ahead' },
  { value: '12', label: 'Up to 12 months ahead' },
  { value: '24', label: 'Up to 24 months ahead' },
];

export function SettingsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();

  const save = (patch: Parameters<typeof update.mutate>[0], what: string) => {
    update.mutate(patch, {
      onSuccess: () => toast.success(`${what} updated`),
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'That setting could not be saved.'),
    });
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Booking rules</h2>
        <span className={styles.sectionNote}>
          Company rules that shape how bookings behave. Changes take effect immediately.
        </span>
      </div>

      {settings.isPending ? (
        <div className={styles.settings} aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className={styles.setting}>
              <Skeleton width={index % 2 === 0 ? 128 : 156} height={9} />
              <Skeleton height={32} />
              <Skeleton width="88%" height={9} />
            </div>
          ))}
        </div>
      ) : settings.isError || !settings.data ? (
        <p className={styles.settingNote}>The booking rules could not be loaded.</p>
      ) : (
        <div className={styles.settings}>
          <div className={styles.setting}>
            <Field label="Committee slots">
              {(props) => (
                <select
                  {...props}
                  className={controlClass}
                  value={settings.data.bookingSlotUniqueness}
                  disabled={update.isPending}
                  onChange={(event) =>
                    save(
                      { bookingSlotUniqueness: event.target.value as SlotUniqueness },
                      'Committee slot rule',
                    )
                  }
                >
                  {SLOT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <p className={styles.settingNote}>
              Currently a committee session is shared: one committee sitting at one date and time
              reviews several projects, and different committees run in parallel. The stricter
              options make a slot exclusive and reject a second booking for it.
            </p>
          </div>

          <div className={styles.setting}>
            <Field label="Who can edit a booking">
              {(props) => (
                <select
                  {...props}
                  className={controlClass}
                  value={settings.data.bookingEditPolicy}
                  disabled={update.isPending}
                  onChange={(event) =>
                    save(
                      { bookingEditPolicy: event.target.value as BookingEditPolicy },
                      'Edit permission',
                    )
                  }
                >
                  {EDIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <p className={styles.settingNote}>
              Applies to editing and cancelling. Every change is attributed and kept in the
              booking's history whichever rule is in force.
            </p>
          </div>

          <div className={styles.setting}>
            <Field label="How far ahead bookings can be made">
              {(props) => (
                <select
                  {...props}
                  className={controlClass}
                  value={
                    settings.data.bookingFutureHorizonMonths === null
                      ? ''
                      : String(settings.data.bookingFutureHorizonMonths)
                  }
                  disabled={update.isPending}
                  onChange={(event) =>
                    save(
                      {
                        bookingFutureHorizonMonths:
                          event.target.value === '' ? null : Number(event.target.value),
                      },
                      'Booking horizon',
                    )
                  }
                >
                  {HORIZON_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <p className={styles.settingNote}>
              Limits future bookings only. Past dates stay open so an omission can always be
              corrected in the record.
            </p>
          </div>

          <div className={styles.setting}>
            <Field label="Who receives notifications">
              {(props) => (
                <select
                  {...props}
                  className={controlClass}
                  value={settings.data.notificationAudience}
                  disabled={update.isPending}
                  onChange={(event) =>
                    save(
                      { notificationAudience: event.target.value as NotificationAudience },
                      'Notification audience',
                    )
                  }
                >
                  {AUDIENCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <p className={styles.settingNote}>
              Sent when a booking is created, changed or cancelled. The email says what changed and
              links to the live plan — it never attaches a spreadsheet.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
