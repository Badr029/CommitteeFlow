import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Plus, X } from 'lucide-react';
import type { PlanFieldType } from '@shared/api-types';
import { ApiError } from '@/api/client';
import { useCreatePlanField } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { drawerFootSpacer } from '@/components/ui/classes';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
import styles from './PlanConfigPage.module.css';

/**
 * Add a custom field (spec §21, §22).
 *
 * The type list is deliberately short. CommitteeFlow is not a spreadsheet
 * builder: there are no formulas, no scripts, no relations (spec §22, §82).
 */
const TYPES: Array<{ value: PlanFieldType; label: string; hint: string }> = [
  { value: 'TEXT', label: 'Text', hint: 'A short single-line value.' },
  { value: 'LONG_TEXT', label: 'Long text', hint: 'A paragraph, such as extra notes.' },
  { value: 'NUMBER', label: 'Number', hint: 'A quantity or measurement.' },
  { value: 'SELECT', label: 'Select', hint: 'One value from a fixed list you define.' },
  { value: 'DATE', label: 'Date', hint: 'A calendar date.' },
  { value: 'TIME', label: 'Time', hint: 'A time of day.' },
  { value: 'CHECKBOX', label: 'Checkbox', hint: 'A yes or no.' },
];

/** Suggests a stable technical key from the label, without ever deriving it silently. */
function suggestKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1')
    .slice(0, 63);
}

export function AddFieldDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreatePlanField();

  const [label, setLabel] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [fieldType, setFieldType] = useState<PlanFieldType>('TEXT');
  const [helpText, setHelpText] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [options, setOptions] = useState<string[]>(['']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const selectedType = TYPES.find((type) => type.value === fieldType);
  const effectiveKey = keyTouched ? fieldKey : suggestKey(label);

  const submit = () => {
    setErrors({});
    setFormError(null);

    const cleanedOptions = options.map((option) => option.trim()).filter(Boolean);

    create.mutate(
      {
        fieldKey: effectiveKey,
        label: label.trim(),
        fieldType,
        isRequired,
        ...(helpText.trim() ? { helpText: helpText.trim() } : {}),
        ...(fieldType === 'SELECT' ? { options: cleanedOptions } : {}),
      },
      {
        onSuccess: (created) => {
          toast.success(`“${created.label}” added to the plan`, {
            description: 'It now appears on the booking form, the plan and both exports.',
          });
          onClose();
        },
        onError: (error) => {
          if (!(error instanceof ApiError)) {
            setFormError('The field could not be added.');
            return;
          }
          setErrors(error.fieldErrors());
          if (error.issues.length === 0) setFormError(error.message);
        },
      },
    );
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Add a custom field"
      subtitle="Stored alongside each booking. Existing bookings simply leave it empty."
      footer={
        <>
          <span className={drawerFootSpacer} />
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={create.isPending}
            disabled={!label.trim() || !effectiveKey}
          >
            Add field
          </Button>
        </>
      }
    >
      <div className={styles.addForm}>
        {formError && (
          <div className={styles.banner} role="alert">
            <AlertTriangle size={15} className={styles.bannerIcon} aria-hidden="true" />
            <span>{formError}</span>
          </div>
        )}

        <div className={styles.addGrid}>
          <Field label="Label" required error={errors['label']} className={styles.addSpan}>
            {(props) => (
              <input
                {...props}
                className={controlClass}
                value={label}
                autoFocus
                maxLength={120}
                placeholder="Project Manager"
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Technical key"
            required
            help="Never changes, even if the label is renamed later."
            error={errors['fieldKey']}
          >
            {(props) => (
              <input
                {...props}
                className={controlClass}
                value={effectiveKey}
                maxLength={63}
                placeholder="project_manager"
                onChange={(event) => {
                  setKeyTouched(true);
                  setFieldKey(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Type" required help={selectedType?.hint} error={errors['fieldType']}>
            {(props) => (
              <select
                {...props}
                className={controlClass}
                value={fieldType}
                onChange={(event) => setFieldType(event.target.value as PlanFieldType)}
              >
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {fieldType === 'SELECT' && (
            <div className={styles.addSpan}>
              <Field
                label="Options"
                required
                help="The values an engineer can choose from."
                error={errors['options']}
              >
                {() => (
                  <div className={styles.optionList}>
                    {options.map((option, index) => (
                      <div key={index} className={styles.optionRow}>
                        <input
                          className={controlClass}
                          value={option}
                          maxLength={120}
                          placeholder={index === 0 ? 'Routine' : 'Another option'}
                          aria-label={`Option ${index + 1}`}
                          onChange={(event) =>
                            setOptions((current) =>
                              current.map((value, position) =>
                                position === index ? event.target.value : value,
                              ),
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          iconOnly
                          icon={<X size={14} />}
                          aria-label={`Remove option ${index + 1}`}
                          disabled={options.length === 1}
                          onClick={() =>
                            setOptions((current) => current.filter((_, position) => position !== index))
                          }
                        />
                      </div>
                    ))}
                    <Button
                      variant="secondary"
                      size="small"
                      icon={<Plus size={13} />}
                      onClick={() => setOptions((current) => [...current, ''])}
                    >
                      Add option
                    </Button>
                  </div>
                )}
              </Field>
            </div>
          )}

          <Field
            label="Help text"
            showOptional
            help="Shown under the input on the booking form."
            error={errors['helpText']}
            className={styles.addSpan}
          >
            {(props) => (
              <input
                {...props}
                className={controlClass}
                value={helpText}
                maxLength={300}
                onChange={(event) => setHelpText(event.target.value)}
              />
            )}
          </Field>

          <Field label="Required" className={styles.addSpan}>
            {(props) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
                <input
                  {...props}
                  type="checkbox"
                  checked={isRequired}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                  onChange={(event) => setIsRequired(event.target.checked)}
                />
                <label htmlFor={props.id} style={{ fontSize: 'var(--text-base)' }}>
                  Every new booking must fill this in
                </label>
              </div>
            )}
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
