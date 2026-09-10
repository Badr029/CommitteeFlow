import { ArrowRight, Info } from 'lucide-react';
import type { ImportPreviewResponse } from '@shared/api-types';
import { cn } from '@/lib/cn';
import styles from './import.module.css';

/**
 * Mapping uploaded columns to Committee Plan fields (spec §11, §12).
 *
 * Every column is listed, including the ones matched confidently, because
 * "what did it decide about the rest of my file" is exactly the question this
 * step exists to answer. A column the importer would not guess at is marked and
 * carries the reason, so the choice is informed rather than a shrug.
 *
 * Rows on a phone, a table on a desktop — the same control either way.
 */
export function ImportMapping({
  preview,
  mapping,
  onChange,
}: {
  preview: ImportPreviewResponse;
  mapping: Record<string, string | null>;
  onChange: (mapping: Record<string, string | null>) => void;
  /** Kept for symmetry with the drawer's footer action. */
  onApply?: () => void;
}) {
  // A field already taken by another column cannot be offered twice.
  const takenBy = new Map<string, string>();
  for (const [header, fieldKey] of Object.entries(mapping)) {
    if (fieldKey) takenBy.set(fieldKey, header);
  }

  const undecided = preview.columns.filter(
    (column) => (mapping[column.header] ?? null) === null && column.reason !== null,
  ).length;

  return (
    <section className={styles.mapping}>
      <div className={styles.mappingIntro}>
        <Info size={15} aria-hidden="true" className={styles.mappingIntroIcon} />
        <p>
          {undecided === 0
            ? 'Every column has a destination. Change any of them before continuing.'
            : `${undecided} column${undecided === 1 ? ' needs' : 's need'} a decision. Choose a field, or leave it as “Do not import”.`}
        </p>
      </div>

      <ul className={styles.mapList}>
        {preview.columns.map((column) => {
          const value = mapping[column.header] ?? '';
          const unresolved = value === '' && column.reason !== null;

          return (
            <li key={column.header} className={cn(styles.mapRow, unresolved && styles.mapRowAttention)}>
              <div className={styles.mapSource}>
                <span className={styles.mapHeader}>{column.header}</span>
                {column.sampleValues.length > 0 && (
                  <span className={styles.mapSamples}>{column.sampleValues.join(' · ')}</span>
                )}
              </div>

              <ArrowRight size={15} aria-hidden="true" className={styles.mapArrow} />

              <div className={styles.mapTarget}>
                <label className="sr-only" htmlFor={`map-${column.index}`}>
                  Committee Plan field for the {column.header} column
                </label>
                <select
                  id={`map-${column.index}`}
                  className={styles.mapSelect}
                  value={value}
                  onChange={(event) =>
                    onChange({ ...mapping, [column.header]: event.target.value || null })
                  }
                >
                  <option value="">Do not import</option>
                  {preview.fields.map((field) => {
                    const owner = takenBy.get(field.fieldKey);
                    const takenElsewhere = owner !== undefined && owner !== column.header;
                    return (
                      <option key={field.fieldKey} value={field.fieldKey} disabled={takenElsewhere}>
                        {field.label}
                        {field.isRequired ? ' (required)' : ''}
                        {takenElsewhere ? ` — already from ${owner}` : ''}
                      </option>
                    );
                  })}
                </select>

                {column.reason && (
                  <p className={cn(styles.mapReason, unresolved && styles.mapReasonAttention)}>
                    {column.reason}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
