import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Archive as ArchiveIcon,
  Check,
  Lock,
  Plus,
  X,
} from 'lucide-react';
import type { PlanField } from '@shared/api-types';
import { ApiError } from '@/api/client';
import {
  useArchivePlanField,
  useConfigurationHistory,
  usePlanFields,
  useReorderPlanFields,
  useRestorePlanField,
  useUpdatePlanField,
  type ConfigurationHistoryEntry,
} from '@/api/queries';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { Skeleton } from '@/components/ui/Skeleton';
import { AddFieldDrawer } from './AddFieldDrawer';
import { PlanAccessPanel } from './PlanAccessPanel';
import { PaginationControls } from './PaginationControls';
import { SettingsPanel } from './SettingsPanel';
import styles from './PlanConfigPage.module.css';

const TYPE_LABEL: Record<PlanField['fieldType'], string> = {
  TEXT: 'Text',
  LONG_TEXT: 'Long text',
  NUMBER: 'Number',
  SELECT: 'Select',
  DATE: 'Date',
  TIME: 'Time',
  CHECKBOX: 'Checkbox',
};

/**
 * Plan Configuration (spec §19–§25).
 *
 * Changes here reshape the booking form, the plan table, the detail view and
 * both exports at once, because all five read the same definitions (spec §77).
 * The screen states plainly what is locked and why, rather than presenting a
 * control that silently does nothing.
 */
export function PlanConfigPage() {
  const planFields = usePlanFields();
  const update = useUpdatePlanField();
  const reorder = useReorderPlanFields();
  const archive = useArchivePlanField();
  const restore = useRestorePlanField();
  const [historyPage, setHistoryPage] = useState(1);
  const history = useConfigurationHistory(true, historyPage);

  const [adding, setAdding] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<PlanField | null>(null);

  const fields = useMemo(
    () => [...(planFields.data ?? [])].sort((a, b) => a.displayOrder - b.displayOrder),
    [planFields.data],
  );
  const active = fields.filter((field) => field.isActive);
  const archived = fields.filter((field) => !field.isActive);

  const onError = (error: unknown) => {
    toast.error(
      error instanceof ApiError ? error.message : 'That change could not be saved.',
    );
  };

  const rename = (field: PlanField, label: string) => {
    const trimmed = label.trim();
    if (trimmed === '' || trimmed === field.label) return;
    update.mutate({ id: field.id, patch: { label: trimmed } }, { onError });
  };

  const toggle = (field: PlanField, patch: Record<string, boolean>) => {
    update.mutate({ id: field.id, patch }, { onError });
  };

  const move = (field: PlanField, direction: -1 | 1) => {
    const index = active.findIndex((candidate) => candidate.id === field.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= active.length) return;

    const next = [...active];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);

    reorder.mutate(
      next.map((candidate) => candidate.id),
      { onError },
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <h1 className={styles.title}>Plan Configuration</h1>
          <p className={styles.subtitle}>
            The business-facing shape of the Committee Plan. What you change here drives the
            booking form, the plan table, booking details and both exports — no code change and no
            new spreadsheet.
          </p>
        </div>
        <span className={styles.spacer} />
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          Add custom field
        </Button>
      </header>

      <div className={styles.scroll}>
        <div className={styles.column}>
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Plan fields</h2>
              <span className={styles.sectionNote}>
                Rename, reorder, show or hide, and choose what is required.
              </span>
            </div>

            {planFields.isPending ? (
              <FieldListSkeleton />
            ) : (
              <div className={styles.fieldList}>
                {active.map((field, index) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    first={index === 0}
                    last={index === active.length - 1}
                    busy={update.isPending || reorder.isPending}
                    onRename={(label) => rename(field, label)}
                    onToggle={(patch) => toggle(field, patch)}
                    onMove={(direction) => move(field, direction)}
                    onArchive={() => setPendingArchive(field)}
                  />
                ))}
              </div>
            )}
          </section>

          {archived.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>Archived fields</h2>
                <span className={styles.sectionNote}>
                  Hidden from new bookings. Existing bookings keep their values, and those values
                  still appear on the booking's detail view.
                </span>
              </div>
              <div className={styles.fieldList}>
                {archived.map((field) => (
                  <div key={field.id} className={cn(styles.fieldRow, styles.fieldRowArchived)}>
                    <span />
                    <div className={styles.labelCell}>
                      <span className={styles.labelInput}>{field.label}</span>
                      <span className={styles.fieldKey}>{field.fieldKey}</span>
                    </div>
                    <div className={styles.typeCell}>
                      <Pill>{TYPE_LABEL[field.fieldType]}</Pill>
                    </div>
                    <span />
                    <span className={styles.settingNote}>
                      {field.editability.populatedBookingCount} booking
                      {field.editability.populatedBookingCount === 1 ? '' : 's'} hold a value
                    </span>
                    <div className={styles.actionsCell}>
                      <Button
                        variant="secondary"
                        size="small"
                        icon={<ArchiveRestore size={13} />}
                        loading={restore.isPending}
                        onClick={() => restore.mutate(field.id, { onError })}
                      >
                        Restore
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <SettingsPanel />

          <PlanAccessPanel />

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Configuration history</h2>
              <span className={styles.sectionNote}>
                Every change to the plan's shape, and who made it.
              </span>
            </div>
            <ConfigurationHistory
              entries={history.data?.entries}
              loading={history.isPending}
            />
            {history.data && (
              <PaginationControls
                page={historyPage}
                pageSize={history.data.limit}
                total={history.data.total}
                loading={history.isFetching}
                itemLabel="configuration history entries"
                onPageChange={setHistoryPage}
              />
            )}
          </section>
        </div>
      </div>

      {adding && <AddFieldDrawer open onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => !open && setPendingArchive(null)}
        title={`Archive “${pendingArchive?.label ?? ''}”?`}
        description={
          <>
            It disappears from new booking forms, the plan table and the exports. Nothing is
            deleted: the{' '}
            {pendingArchive?.editability.populatedBookingCount ?? 0} booking
            {pendingArchive?.editability.populatedBookingCount === 1 ? '' : 's'} that already hold a
            value keep it, and you can restore the field at any time.
          </>
        }
        confirmLabel="Archive field"
        cancelLabel="Keep it"
        loading={archive.isPending}
        onConfirm={() => {
          if (!pendingArchive) return;
          archive.mutate(pendingArchive.id, {
            onSuccess: () => {
              toast.success(`“${pendingArchive.label}” archived`);
              setPendingArchive(null);
            },
            onError: (error) => {
              setPendingArchive(null);
              onError(error);
            },
          });
        }}
      />
    </div>
  );
}

function FieldRow({
  field,
  first,
  last,
  busy,
  onRename,
  onToggle,
  onMove,
  onArchive,
}: {
  field: PlanField;
  first: boolean;
  last: boolean;
  busy: boolean;
  onRename: (label: string) => void;
  onToggle: (patch: Record<string, boolean>) => void;
  onMove: (direction: -1 | 1) => void;
  onArchive: () => void;
}) {
  const [draft, setDraft] = useState(field.label);
  const { editability } = field;
  const dirty = draft.trim() !== '' && draft.trim() !== field.label;

  return (
    <div className={styles.fieldRow}>
      <div className={styles.orderControls}>
        <button
          type="button"
          className={styles.orderButton}
          disabled={first || busy}
          onClick={() => onMove(-1)}
          aria-label={`Move ${field.label} up`}
        >
          <ArrowUp size={11} />
        </button>
        <button
          type="button"
          className={styles.orderButton}
          disabled={last || busy}
          onClick={() => onMove(1)}
          aria-label={`Move ${field.label} down`}
        >
          <ArrowDown size={11} />
        </button>
      </div>

      <div className={styles.labelCell}>
        <div className={styles.labelEditRow}>
          <input
            className={styles.labelInput}
            value={draft}
            disabled={busy}
            aria-label={`Label for ${field.fieldKey}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (dirty) onRename(draft);
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                setDraft(field.label);
                event.currentTarget.blur();
              }
            }}
          />
          {/*
            * Renaming used to save the moment the input lost focus, which meant
            * clicking anywhere else on the page committed a change nobody had
            * asked to commit yet. A typed label is now a draft — visible here,
            * not yet applied to the booking form or the plan table — until it
            * is explicitly accepted or cancelled.
            */}
          {dirty && (
            <div className={styles.labelEditActions}>
              <button
                type="button"
                className={cn(styles.labelEditButton, styles.labelEditAccept)}
                disabled={busy}
                aria-label={`Accept the new label for ${field.fieldKey}`}
                title="Accept changes"
                onClick={() => onRename(draft)}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                className={styles.labelEditButton}
                disabled={busy}
                aria-label={`Discard the new label for ${field.fieldKey}`}
                title="Discard changes"
                onClick={() => setDraft(field.label)}
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>
        {/* The technical key never changes, whatever the label becomes (§20). */}
        <span className={styles.fieldKey}>{field.fieldKey}</span>
      </div>

      <div className={styles.typeCell}>
        <Pill>{TYPE_LABEL[field.fieldType]}</Pill>
        {field.fieldClass === 'SYSTEM' && (
          <Pill tone="accent" icon={<Lock size={10} />} title={editability.lockedReason ?? undefined}>
            System
          </Pill>
        )}
      </div>

      {/*
        * Transparent on a wide screen (`display: contents`), so the desktop
        * grid still sees two independent cells; a real row on a narrow one,
        * where the two switches share a line of their own.
        */}
      <div className={styles.toggleGroup}>
        <label className={styles.toggleCell}>
          <input
            type="checkbox"
            checked={field.isVisible}
            disabled={!editability.canToggleVisibility || busy}
            onChange={(event) => onToggle({ isVisible: event.target.checked })}
          />
          Visible
        </label>

        <label className={styles.toggleCell}>
          <input
            type="checkbox"
            checked={field.isRequired}
            disabled={!editability.canToggleRequired || busy}
            onChange={(event) => onToggle({ isRequired: event.target.checked })}
          />
          Required
        </label>
      </div>

      <div className={styles.actionsCell}>
        {editability.canArchive ? (
          <Button
            variant="ghost"
            size="small"
            icon={<ArchiveIcon size={13} />}
            onClick={onArchive}
            disabled={busy}
          >
            Archive
          </Button>
        ) : (
          <span className={styles.settingNote}>
            {editability.populatedBookingCount > 0
              ? `${editability.populatedBookingCount} in use`
              : '0 in use'}
          </span>
        )}
      </div>

      {field.fieldClass === 'SYSTEM' && editability.lockedReason && (
        <p className={styles.lockNote}>{editability.lockedReason}</p>
      )}
    </div>
  );
}

function ConfigurationHistory({
  entries,
  loading,
}: {
  entries: ConfigurationHistoryEntry[] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className={styles.history} aria-busy="true">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={styles.historyRow}>
            <Skeleton width={140} height={11} />
            <Skeleton width={70} height={11} />
            <Skeleton width={index % 2 === 0 ? '58%' : '76%'} height={11} />
          </div>
        ))}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        title="No configuration changes yet"
        body="Rename a field, change what is required, or add a custom field — every change is recorded here with its author."
      />
    );
  }

  return (
    <div className={styles.history}>
      {entries.map((entry) => (
        <div key={entry.id} className={styles.historyRow}>
          <span className={styles.historyWhen}>{formatTimestamp(entry.changedAt)}</span>
          <span>
            <Pill
              tone={
                entry.action === 'CREATE'
                  ? 'ok'
                  : entry.action === 'ARCHIVE'
                    ? 'warn'
                    : 'neutral'
              }
            >
              {entry.action}
            </Pill>
          </span>
          <span className={styles.historyWhat}>
            <span className={styles.historyWho}>{entry.changedBy?.name ?? 'Someone'}</span>{' '}
            {describeConfigChange(entry)}
          </span>
        </div>
      ))}
    </div>
  );
}

function describeConfigChange(entry: ConfigurationHistoryEntry): React.ReactNode {
  const key = entry.fieldKey;

  /*
   * Who may configure the plan is recorded in the same trail as the fields —
   * it is part of the plan's configuration — but it is not a field, so it gets
   * a sentence rather than the field diff below.
   */
  if (key === 'plan_configuration_access') {
    const granted = Boolean(entry.newValue?.['canManagePlanConfiguration']);
    const who = String(entry.newValue?.['user'] ?? 'someone');
    return (
      <>
        {granted ? 'gave' : 'removed'} <strong>{who}</strong>
        {granted ? ' access to Plan Configuration' : '’s access to Plan Configuration'}
      </>
    );
  }

  switch (entry.action) {
    case 'CREATE':
      return `added the field “${String(entry.newValue?.['label'] ?? key)}”`;
    case 'ARCHIVE':
      return `archived “${String(entry.oldValue?.['label'] ?? key)}”`;
    case 'RESTORE':
      return `restored “${String(entry.newValue?.['label'] ?? key)}”`;
    case 'REORDER':
      return 'reordered the plan fields';
    case 'UPDATE':
    default: {
      const changes: React.ReactNode[] = [];
      const before = entry.oldValue ?? {};
      const after = entry.newValue ?? {};
      for (const property of ['label', 'isRequired', 'isVisible', 'fieldType', 'helpText']) {
        if (JSON.stringify(before[property]) === JSON.stringify(after[property])) continue;
        changes.push(
          <span key={property} className={styles.diff}>
            {' '}
            {property === 'label'
              ? 'label'
              : property === 'isRequired'
                ? 'required'
                : property === 'isVisible'
                  ? 'visible'
                  : property === 'fieldType'
                    ? 'type'
                    : 'help text'}{' '}
            <span className={styles.diffFrom}>{show(before[property])}</span>
            {' → '}
            <span className={styles.diffTo}>{show(after[property])}</span>
          </span>,
        );
      }
      return (
        <>
          changed <strong>{String(after['label'] ?? key)}</strong>
          {changes.length > 0 ? ':' : ''}
          {changes}
        </>
      );
    }
  }
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function FieldListSkeleton() {
  return (
    <div className={styles.fieldList} aria-busy="true" aria-label="Loading the plan fields">
      {Array.from({ length: 11 }, (_, index) => (
        <div key={index} className={styles.fieldRow}>
          <Skeleton width={22} height={31} />
          <div className={styles.labelCell}>
            <Skeleton width={index % 3 === 0 ? 96 : 132} height={12} />
            <Skeleton width={index % 2 === 0 ? 72 : 104} height={9} />
          </div>
          <Skeleton width={62} height={16} />
          <Skeleton width={68} height={12} />
          <Skeleton width={72} height={12} />
          <span />
        </div>
      ))}
    </div>
  );
}
