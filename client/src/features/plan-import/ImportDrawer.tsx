import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CheckCircle2 } from 'lucide-react';
import type { ImportPreviewResponse } from '@shared/api-types';
import { ApiError } from '@/api/client';
import { useConfirmImport, usePreviewImport } from '@/api/queries';
import { cn } from '@/lib/cn';
import { useIsCompact } from '@/lib/viewport';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { drawerFootSpacer } from '@/components/ui/classes';
import { Skeleton } from '@/components/ui/Skeleton';
import { ImportDropzone } from './ImportDropzone';
import { ImportMapping } from './ImportMapping';
import { ImportPreviewTable } from './ImportPreviewTable';
import styles from './import.module.css';

/**
 * Import a Committee Plan from Excel or CSV (spec §5).
 *
 * Four steps, in one drawer rather than a page of its own: importing is an
 * action *on* the plan, and the plan stays behind it. The step that matters is
 * the third — nothing reaches the database until the user has seen what
 * CommitteeFlow made of their file and pressed a button that says so.
 *
 * The chosen `File` is held here for the whole flow because the server keeps no
 * parsed state between preview and confirm: it re-reads and re-validates the
 * bytes, so the file has to be sent twice.
 */

type Step = 'upload' | 'map' | 'preview' | 'done';

export function ImportDrawer({ onClose, onImported }: { onClose: () => void; onImported: (month: string) => void }) {
  const compact = useIsCompact();
  const preview = usePreviewImport();
  const confirm = useConfirmImport();

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const [imported, setImported] = useState<{ count: number; skipped: number; filename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A dirty-close guard: an upload in flight must not be interrupted, and a
  // reviewed preview is worth a confirmation before discarding.
  const busy = preview.isPending || confirm.isPending;

  const run = (chosen: File, nextMapping?: Record<string, string | null>) => {
    setError(null);
    preview.mutate(
      { file: chosen, ...(nextMapping ? { mapping: nextMapping } : {}) },
      {
        onSuccess: (data) => {
          setFile(chosen);
          setResult(data);
          setMapping(data.mapping);
          setSkipped(new Set());

          /*
           * Only the *first* read routes to the mapping step, and only when a
           * column the importer would not guess at is left undecided. Once the
           * user has answered — including by leaving a column out — re-reading
           * goes straight to the preview.
           *
           * Re-deriving this from the response every time would trap them: a
           * column the importer cannot suggest a field for still cannot be
           * suggested a field for on the second pass, so "Check the data" would
           * return to the same screen forever.
           */
          if (nextMapping) {
            setStep('preview');
            return;
          }

          const needsDecision = data.columns.some(
            (column) => column.suggestedFieldKey === null && column.reason !== null,
          );
          setStep(needsDecision ? 'map' : 'preview');
        },
        onError: (cause) => {
          setError(cause instanceof ApiError ? cause.message : 'That file could not be read.');
        },
      },
    );
  };

  const importable = useMemo(
    () => (result?.rows ?? []).filter((row) => row.status !== 'error' && !skipped.has(row.index)),
    [result, skipped],
  );

  const submit = () => {
    if (!result || !file) return;
    setError(null);
    confirm.mutate(
      {
        batchId: result.batchId,
        file,
        rowIndexes: importable.map((row) => row.index),
        mapping,
        sheet: result.sheetName,
      },
      {
        onSuccess: (data) => {
          setImported({
            count: data.importedRows,
            skipped: data.skippedRows,
            filename: data.batch.originalFilename,
          });
          setStep('done');
          toast.success(
            `${data.importedRows} booking${data.importedRows === 1 ? '' : 's'} imported`,
            { description: 'Everyone on the plan is notified once, not per booking.' },
          );
          if (data.batch.firstBookingDate) onImported(data.batch.firstBookingDate.slice(0, 7));
        },
        onError: (cause) => {
          setError(
            cause instanceof ApiError ? cause.message : 'The import could not be completed.',
          );
        },
      },
    );
  };

  const requestClose = () => {
    if (busy) return false;
    // Nothing has been written yet, so abandoning a preview costs only the
    // upload — worth no dialog, unlike discarding typed work.
    return true;
  };

  return (
    <Drawer
      open
      wide
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onRequestClose={requestClose}
      title={step === 'done' ? 'Import complete' : 'Import Committee Plan'}
      subtitle={subtitleFor(step, result)}
      footer={footerFor()}
    >
      <div className={styles.wizard}>
        <StepTrail step={step} />

        {error && (
          <div className={styles.banner} role="alert">
            <AlertTriangle size={15} className={styles.bannerIcon} aria-hidden="true" />
            <div className={styles.bannerBody}>
              <span className={styles.bannerTitle}>That did not work</span>
              <span>{error}</span>
            </div>
          </div>
        )}

        {step === 'upload' && (
          <ImportDropzone busy={preview.isPending} onFile={(chosen) => run(chosen)} />
        )}

        {preview.isPending && step !== 'upload' && <PreviewSkeleton />}

        {step === 'map' && result && !preview.isPending && (
          <ImportMapping
            preview={result}
            mapping={mapping}
            onChange={setMapping}
            onApply={() => {
              if (file) run(file, mapping);
            }}
          />
        )}

        {step === 'preview' && result && !preview.isPending && (
          <ImportPreviewTable
            preview={result}
            compact={compact}
            skipped={skipped}
            onToggleSkip={(index) =>
              setSkipped((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })
            }
          />
        )}

        {step === 'done' && imported && (
          <div className={styles.done}>
            <CheckCircle2 size={34} strokeWidth={1.6} className={styles.doneIcon} aria-hidden="true" />
            <p className={styles.doneTitle}>
              {imported.count} booking{imported.count === 1 ? '' : 's'} imported
            </p>
            <dl className={styles.doneFacts}>
              <div>
                <dt>File</dt>
                <dd>{imported.filename}</dd>
              </div>
              {imported.skipped > 0 && (
                <div>
                  <dt>Not imported</dt>
                  <dd>{imported.skipped} rows</dd>
                </div>
              )}
            </dl>
            <p className={styles.doneNote}>
              Everyone on the plan receives one summary email about this import, not one per
              booking.
            </p>
          </div>
        )}
      </div>
    </Drawer>
  );

  function footerFor() {
    if (step === 'done') {
      return (
        <>
          <span className={drawerFootSpacer} />
          <Button variant="primary" onClick={onClose}>
            View the plan
          </Button>
        </>
      );
    }

    if (step === 'upload') {
      return (
        <>
          <span className={styles.footNote}>Nothing is imported until you confirm.</span>
          <span className={drawerFootSpacer} />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      );
    }

    if (step === 'map') {
      return (
        <>
          <span className={drawerFootSpacer} />
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => setStep('upload')} disabled={busy}>
            Back
          </Button>
          <Button
            variant="primary"
            loading={preview.isPending}
            onClick={() => {
              if (file) run(file, mapping);
            }}
          >
            Check the data
          </Button>
        </>
      );
    }

    const count = importable.length;
    return (
      <>
        <span className={drawerFootSpacer} />
        <Button variant="ghost" onClick={() => setStep('map')} disabled={busy}>
          Change mapping
        </Button>
        <Button variant="primary" loading={confirm.isPending} disabled={count === 0} onClick={submit}>
          {count === 0 ? 'Nothing to import' : `Import ${count} booking${count === 1 ? '' : 's'}`}
        </Button>
      </>
    );
  }
}

function subtitleFor(step: Step, preview: ImportPreviewResponse | null): string {
  switch (step) {
    case 'upload':
      return 'Excel (.xlsx, .xls) or CSV (.csv).';
    case 'map':
      return 'Check where each column belongs before the data is read.';
    case 'preview':
      return preview
        ? `${preview.filename} · ${preview.sheetName}`
        : 'Review what will be added to the plan.';
    case 'done':
      return 'The plan has been updated.';
    default: {
      const never: never = step;
      return String(never);
    }
  }
}

/** Where you are in the flow, and that confirming comes last. */
function StepTrail({ step }: { step: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: 'upload', label: 'File' },
    { id: 'map', label: 'Columns' },
    { id: 'preview', label: 'Review' },
    { id: 'done', label: 'Imported' },
  ];
  const currentIndex = steps.findIndex((candidate) => candidate.id === step);

  return (
    <ol className={styles.trail} aria-label="Import steps">
      {steps.map((candidate, index) => (
        <li
          key={candidate.id}
          className={cn(
            styles.trailStep,
            index === currentIndex && styles.trailStepCurrent,
            index < currentIndex && styles.trailStepDone,
          )}
          aria-current={index === currentIndex ? 'step' : undefined}
        >
          <span className={styles.trailDot} aria-hidden="true" />
          {candidate.label}
        </li>
      ))}
    </ol>
  );
}

function PreviewSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Reading the file">
      <Skeleton height={38} />
      <Skeleton height={90} />
      {[0, 1, 2, 3, 4].map((index) => (
        <Skeleton key={index} height={30} />
      ))}
    </div>
  );
}
