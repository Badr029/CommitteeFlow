import { useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, CopyCheck } from 'lucide-react';
import type { ImportPreviewResponse, ImportPreviewRow } from '@shared/api-types';
import { cn } from '@/lib/cn';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import styles from './import.module.css';

/**
 * What CommitteeFlow made of the file (spec §20, §21, §22).
 *
 * Shows the *normalized* data — the dates, times and values as they will be
 * stored — not the raw cells, because the question this screen answers is
 * "is this what will end up in the plan", and raw cells cannot answer it.
 *
 * Rows carry their own problems rather than pushing them into a separate list:
 * an error is only actionable next to the row it belongs to and the source row
 * number that finds it in the spreadsheet.
 */

type Filter = 'all' | 'valid' | 'warning' | 'error';

/** The columns worth a table; the rest are on the row's own detail. */
const PRIMARY_KEYS = [
  'booking_date',
  'booking_time',
  'committee',
  'off_no',
  'order_name',
  'qty',
  'kva',
  'kv',
  'status',
] as const;

export function ImportPreviewTable({
  preview,
  compact,
  skipped,
  onToggleSkip,
}: {
  preview: ImportPreviewResponse;
  compact: boolean;
  skipped: ReadonlySet<number>;
  onToggleSkip: (index: number) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');

  const columns = useMemo(
    () =>
      preview.fields.filter((field) =>
        (PRIMARY_KEYS as readonly string[]).includes(field.fieldKey),
      ),
    [preview.fields],
  );

  const rows = useMemo(
    () => (filter === 'all' ? preview.rows : preview.rows.filter((row) => row.status === filter)),
    [preview.rows, filter],
  );

  const willImport = preview.rows.filter(
    (row) => row.status !== 'error' && !skipped.has(row.index),
  ).length;

  return (
    <section className={styles.preview}>
      <div className={styles.summary}>
        <SummaryFigure label="Detected" value={preview.summary.total} />
        <SummaryFigure label="Valid" value={preview.summary.valid} tone="ok" />
        <SummaryFigure label="Warnings" value={preview.summary.warnings} tone="warn" />
        <SummaryFigure label="Errors" value={preview.summary.errors} tone="danger" />
      </div>

      <p className={styles.summaryLine}>
        <strong>{willImport}</strong> of {preview.summary.total} rows will be imported.
        {preview.summary.errors > 0 && ' Rows with errors are never imported.'}
      </p>

      {preview.truncated && (
        <p className={styles.truncated} role="status">
          Only the first {preview.summary.total} rows were read. Split the file if it holds more.
        </p>
      )}

      <div className={styles.filters} role="group" aria-label="Filter rows">
        {(['all', 'valid', 'warning', 'error'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={cn(styles.filter, filter === option && styles.filterOn)}
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
          >
            {option === 'all' ? 'All' : option === 'valid' ? 'Valid' : option === 'warning' ? 'Warnings' : 'Errors'}
            <span className={styles.filterCount}>{countFor(preview, option)}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>No rows in this category.</p>
      ) : compact ? (
        <ul className={styles.cards}>
          {rows.map((row) => (
            <li key={row.index}>
              <RowCard
                row={row}
                skipped={skipped.has(row.index)}
                onToggleSkip={() => onToggleSkip(row.index)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.rowNumberHead}>Row</th>
                {columns.map((field) => (
                  <th key={field.fieldKey} scope="col">
                    {field.label}
                  </th>
                ))}
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RowLine
                  key={row.index}
                  row={row}
                  columns={columns.map((field) => field.fieldKey)}
                  skipped={skipped.has(row.index)}
                  onToggleSkip={() => onToggleSkip(row.index)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function countFor(preview: ImportPreviewResponse, filter: Filter): number {
  switch (filter) {
    case 'all':
      return preview.summary.total;
    case 'valid':
      return preview.summary.valid;
    case 'warning':
      return preview.summary.warnings;
    case 'error':
      return preview.summary.errors;
    default: {
      const never: never = filter;
      return Number(never);
    }
  }
}

function SummaryFigure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className={cn(styles.figure, tone && styles[`figure${tone[0]!.toUpperCase()}${tone.slice(1)}` as keyof typeof styles])}>
      <span className={styles.figureValue}>{value}</span>
      <span className={styles.figureLabel}>{label}</span>
    </div>
  );
}

function RowLine({
  row,
  columns,
  skipped,
  onToggleSkip,
}: {
  row: ImportPreviewRow;
  columns: string[];
  skipped: boolean;
  onToggleSkip: () => void;
}) {
  const blocked = row.status === 'error';

  return (
    <>
      <tr
        className={cn(
          styles.row,
          row.status === 'warning' && styles.rowWarning,
          blocked && styles.rowError,
          skipped && styles.rowSkipped,
        )}
      >
        <td className={styles.rowNumber}>{row.sourceRowNumber}</td>
        {columns.map((fieldKey) => (
          <td key={fieldKey} className={cn(fieldKey === 'off_no' && styles.cellKey)}>
            {renderValue(row, fieldKey)}
          </td>
        ))}
        <td>
          {blocked ? (
            <Pill tone="danger">Error</Pill>
          ) : skipped ? (
            <Pill>Skipped</Pill>
          ) : row.status === 'warning' ? (
            <Pill tone="warn">Warning</Pill>
          ) : (
            <Pill tone="ok">Ready</Pill>
          )}
        </td>
      </tr>

      {(row.issues.length > 0 || row.duplicate) && (
        <tr className={cn(styles.issueRow, blocked && styles.issueRowError)}>
          <td />
          <td colSpan={columns.length + 1}>
            <ul className={styles.issues}>
              {row.issues.map((issue, position) => (
                <li key={`${issue.fieldKey ?? 'row'}-${position}`} className={styles.issue}>
                  {issue.severity === 'error' ? (
                    <CircleAlert size={13} aria-hidden="true" className={styles.issueIconError} />
                  ) : (
                    <AlertTriangle size={13} aria-hidden="true" className={styles.issueIconWarn} />
                  )}
                  <span className={styles.issueLabel}>{issue.label}</span>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>

            {row.duplicate && !blocked && (
              <div className={styles.duplicate}>
                <CopyCheck size={13} aria-hidden="true" />
                <span>{row.duplicate.message}</span>
                <Button variant="linkish" size="small" onClick={onToggleSkip}>
                  {skipped ? 'Import anyway' : 'Skip this row'}
                </Button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A row on a phone.
 *
 * Not a squeezed table: the schedule leads, then the project, then the problems,
 * because that is the order the row is read in when deciding whether to import
 * it.
 */
function RowCard({
  row,
  skipped,
  onToggleSkip,
}: {
  row: ImportPreviewRow;
  skipped: boolean;
  onToggleSkip: () => void;
}) {
  const blocked = row.status === 'error';

  return (
    <article
      className={cn(
        styles.card,
        row.status === 'warning' && styles.cardWarning,
        blocked && styles.cardError,
        skipped && styles.cardSkipped,
      )}
    >
      <header className={styles.cardHead}>
        <span className={styles.cardRowNumber}>Row {row.sourceRowNumber}</span>
        {blocked ? (
          <Pill tone="danger">Error</Pill>
        ) : skipped ? (
          <Pill>Skipped</Pill>
        ) : row.status === 'warning' ? (
          <Pill tone="warn">Warning</Pill>
        ) : (
          <Pill tone="ok">Ready</Pill>
        )}
      </header>

      <p className={styles.cardSchedule}>
        {renderValue(row, 'booking_date')} · {renderValue(row, 'booking_time')} ·{' '}
        {renderValue(row, 'committee')}
      </p>
      <p className={styles.cardProject}>
        <span className={styles.cellKey}>{renderValue(row, 'off_no')}</span>{' '}
        {renderValue(row, 'order_name')}
      </p>

      {row.issues.length > 0 && (
        <ul className={styles.issues}>
          {row.issues.map((issue, position) => (
            <li key={`${issue.fieldKey ?? 'row'}-${position}`} className={styles.issue}>
              {issue.severity === 'error' ? (
                <CircleAlert size={13} aria-hidden="true" className={styles.issueIconError} />
              ) : (
                <AlertTriangle size={13} aria-hidden="true" className={styles.issueIconWarn} />
              )}
              <span className={styles.issueLabel}>{issue.label}</span>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}

      {row.duplicate && !blocked && (
        <div className={styles.duplicate}>
          <CopyCheck size={13} aria-hidden="true" />
          <span>{row.duplicate.message}</span>
          <Button variant="linkish" size="small" onClick={onToggleSkip}>
            {skipped ? 'Import anyway' : 'Skip this row'}
          </Button>
        </div>
      )}
    </article>
  );
}

/** The em dash marks a genuinely empty value, matching the plan's own table. */
function renderValue(row: ImportPreviewRow, fieldKey: string): string {
  const value = row.values[fieldKey];
  if (value !== null && value !== undefined && value !== '') return String(value);
  // Fall back to what the cell said, so an unreadable value is still visible.
  const raw = row.display[fieldKey];
  return raw && raw !== '' ? raw : '—';
}
