import { useId, useRef, useState, type DragEvent } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  ACCEPTED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  MAX_UPLOAD_BYTES,
  extensionOf,
  formatBytes,
} from './file-limits';
import styles from './import.module.css';

/**
 * Choosing the file (spec §6).
 *
 * A real `<input type="file">` does the work — it is what gives keyboard
 * access, the platform file picker, and the accessible name for free. Drag and
 * drop is layered on top for a mouse, never as the only way in.
 *
 * The extension is checked here purely to fail fast and say something useful;
 * the server checks the extension, the MIME type and the file's own bytes
 * before a parser touches it (§7).
 */

export function ImportDropzone({
  busy,
  onFile,
}: {
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = (file: File | undefined) => {
    if (!file) return;
    setSelected(file);

    const extension = extensionOf(file.name);
    if (extension === '.pdf') {
      setProblem(
        'PDF is not supported. CommitteeFlow imports structured spreadsheets only — export the plan as Excel or CSV.',
      );
      return;
    }
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
      setProblem(
        `${extension === '' ? 'That file has no extension' : `${extension} files are not supported`}. Choose an Excel (.xlsx, .xls) or CSV (.csv) file.`,
      );
      return;
    }
    if (file.size === 0) {
      setProblem('That file is empty.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setProblem(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }

    setProblem(null);
    onFile(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    accept(event.dataTransfer.files?.[0]);
  };

  return (
    <div className={styles.uploadStep}>
      {/*
        * The label *is* the drop target, so a click anywhere on it opens the
        * picker without any JavaScript standing in for the control.
        */}
      <div
        className={cn(styles.dropzone, dragging && styles.dropzoneActive, busy && styles.dropzoneBusy)}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          disabled={busy}
          onChange={(event) => accept(event.target.files?.[0])}
        />
        <label htmlFor={inputId} className={styles.dropzoneLabel}>
          <Upload size={26} strokeWidth={1.6} className={styles.dropzoneIcon} aria-hidden="true" />
          <span className={styles.dropzoneTitle}>
            {busy ? 'Reading the file…' : 'Choose a file, or drag one here'}
          </span>
          <span className={styles.dropzoneHint}>
            Excel (.xlsx, .xls) or CSV (.csv), up to {formatBytes(MAX_UPLOAD_BYTES)}
          </span>
        </label>
      </div>

      {selected && (
        <div className={cn(styles.selected, problem && styles.selectedProblem)}>
          <FileSpreadsheet size={16} aria-hidden="true" className={styles.selectedIcon} />
          <span className={styles.selectedName}>{selected.name}</span>
          <span className={styles.selectedSize}>{formatBytes(selected.size)}</span>
        </div>
      )}

      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}

      <section className={styles.expected}>
        <h3 className={styles.expectedTitle}>What the sheet should contain</h3>
        <p className={styles.expectedBody}>
          One row per booking, with a header row naming the columns. The standard headings are
          recognised automatically:
        </p>
        <p className={styles.expectedHeaders}>
          Date · Time · OFF No. · Order Name · Committee · Qty · KVA · KV · Status · Notes ·
          Customer Name
        </p>
        <p className={styles.expectedBody}>
          A <strong>Day</strong> column is not needed — CommitteeFlow works the weekday out from the
          date. Columns it does not recognise can be mapped by hand, or ignored.
        </p>
      </section>
    </div>
  );
}
