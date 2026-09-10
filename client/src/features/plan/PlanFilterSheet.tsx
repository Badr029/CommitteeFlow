import { useState } from 'react';
import type { BookingListResponse } from '@shared/api-types';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { drawerFootSpacer } from '@/components/ui/classes';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
import styles from './PlanToolbar.module.css';

export interface PlanFilters {
  /** A day of the month as `YYYY-MM-DD`, or '' for the whole month. */
  day: string;
  committee: string;
  status: string;
  /** A user id: the engineer whose projects to show. */
  projectEngineer: string;
  onlyMine: boolean;
  includeCancelled: boolean;
}

export interface DayOption {
  date: string;
  label: string;
}

/**
 * Filters, on a surface a thumb can work.
 *
 * The desktop toolbar keeps every filter permanently on screen because it has
 * the width for it. A phone does not, so they move behind one control and are
 * applied in a batch — which also stops each individual toggle from firing its
 * own request while the user is still deciding.
 */
export function PlanFilterSheet({
  filters,
  facets,
  dayOptions,
  canFilterMine,
  onApply,
  onClose,
}: {
  filters: PlanFilters;
  facets: BookingListResponse['facets'] | undefined;
  dayOptions: DayOption[];
  canFilterMine: boolean;
  onApply: (filters: PlanFilters) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PlanFilters>(filters);

  const set = <K extends keyof PlanFilters>(key: K, value: PlanFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const cleared: PlanFilters = {
    day: '',
    projectEngineer: '',
    committee: '',
    status: '',
    onlyMine: false,
    includeCancelled: false,
  };

  return (
    <Drawer
      open
      mobilePresentation="sheet"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Filters"
      subtitle="Narrow the month to what you need to see."
      footer={
        <>
          <span className={drawerFootSpacer} />
          <Button variant="ghost" onClick={() => setDraft(cleared)}>
            Clear all
          </Button>
          <Button variant="primary" onClick={() => onApply(draft)}>
            Show results
          </Button>
        </>
      }
    >
      <div className={styles.filterSheet}>
        {/*
          * Only days the month has bookings on. Offering all 31 numbers would
          * mostly be dead options, and picking one would answer a question the
          * plan already answers by not listing the day.
          */}
        <Field label="Day">
          {(props) => (
            <select
              {...props}
              className={controlClass}
              value={draft.day}
              disabled={dayOptions.length === 0}
              onChange={(event) => set('day', event.target.value)}
            >
              <option value="">
                {dayOptions.length === 0 ? 'No days booked' : 'The whole month'}
              </option>
              {dayOptions.map((option) => (
                <option key={option.date} value={option.date}>
                  {option.label}
                </option>
              ))}
              {draft.day !== '' && !dayOptions.some((option) => option.date === draft.day) && (
                <option value={draft.day}>{draft.day}</option>
              )}
            </select>
          )}
        </Field>

        {/*
          * Whose project it is. Only engineers who own something in this month
          * are offered — a list of everyone with an account would mostly be
          * dead options.
          */}
        <Field label="Project Engineer">
          {(props) => (
            <select
              {...props}
              className={controlClass}
              value={draft.projectEngineer}
              disabled={(facets?.engineers ?? []).length === 0}
              onChange={(event) => set('projectEngineer', event.target.value)}
            >
              <option value="">
                {(facets?.engineers ?? []).length === 0
                  ? 'Nobody assigned this month'
                  : 'All engineers'}
              </option>
              {(facets?.engineers ?? []).map((engineer) => (
                <option key={engineer.id} value={engineer.id}>
                  {engineer.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Committee">
          {(props) => (
            <select
              {...props}
              className={controlClass}
              value={draft.committee}
              onChange={(event) => set('committee', event.target.value)}
            >
              <option value="">All committees</option>
              {(facets?.committees ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {draft.committee !== '' && !(facets?.committees ?? []).includes(draft.committee) && (
                <option value={draft.committee}>{draft.committee}</option>
              )}
            </select>
          )}
        </Field>

        <Field label="Status">
          {(props) => (
            <select
              {...props}
              className={controlClass}
              value={draft.status}
              onChange={(event) => set('status', event.target.value)}
            >
              <option value="">All statuses</option>
              {(facets?.statuses ?? []).map((option) => (
                <option key={option} value={option}>
                  {option === 'CANCELLED' ? 'Cancelled' : 'Planned'}
                </option>
              ))}
              {draft.status !== '' && !(facets?.statuses ?? []).includes(draft.status) && (
                <option value={draft.status}>{draft.status}</option>
              )}
            </select>
          )}
        </Field>

        <div className={styles.switchList}>
          {canFilterMine && (
            <SwitchRow
              label="Only my bookings"
              hint="Bookings you created."
              checked={draft.onlyMine}
              onChange={(value) => set('onlyMine', value)}
            />
          )}
          <SwitchRow
            label="Show cancelled"
            hint="Cancelled bookings stay in the plan's history."
            checked={draft.includeCancelled}
            onChange={(value) => set('includeCancelled', value)}
          />
        </div>
      </div>
    </Drawer>
  );
}

/**
 * A full-width row, not a bare checkbox.
 *
 * The whole row is the target, so the hit area is the width of the sheet rather
 * than the 17px box — the single most common touch failure in a settings list.
 */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={styles.switchRow} data-on={checked}>
      <span className={styles.switchText}>
        <span className={styles.switchLabel}>{label}</span>
        <span className={styles.switchHint}>{hint}</span>
      </span>
      <input
        type="checkbox"
        className={styles.switchInput}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.switchTrack} aria-hidden="true">
        <span className={styles.switchThumb} />
      </span>
    </label>
  );
}
