import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Check, Eye, EyeOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '@/api/client';
import { useChangePassword } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
import { cn } from '@/lib/cn';
import overlay from '@/components/ui/overlay.module.css';
import styles from './PasswordChangeDialog.module.css';

const RULES = [
  ['12+ characters', (value: string) => value.length >= 12],
  ['Uppercase', (value: string) => /[A-Z]/.test(value)],
  ['Lowercase', (value: string) => /[a-z]/.test(value)],
  ['Number', (value: string) => /\d/.test(value)],
  ['Symbol', (value: string) => /[^A-Za-z0-9]/.test(value)],
] as const;

export function PasswordChangeDialog({ open, required, onOpenChange }: {
  open: boolean; required: boolean; onOpenChange: (open: boolean) => void;
}) {
  const change = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revealed, setRevealed] = useState({ current: false, new: false, confirm: false });
  const [clientError, setClientError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missingRule = RULES.some(([, test]) => !test(newPassword));
    if (missingRule) { setClientError('Your new password must meet every rule below.'); return; }
    if (newPassword !== confirmPassword) { setClientError('The new passwords do not match.'); return; }
    if (!required && newPassword === currentPassword) { setClientError('Choose a password different from your current password.'); return; }
    setClientError(null);
    change.mutate(required ? { newPassword } : { currentPassword, newPassword }, {
      onSuccess: () => {
        setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
        setRevealed({ current: false, new: false, confirm: false });
        onOpenChange(false);
      },
    });
  };
  const apiError = change.error instanceof ApiError ? change.error : null;
  const message = clientError ?? apiError?.message ?? null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!required) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay.scrim} />
        <Dialog.Content className={`${overlay.dialog} ${styles.dialog}`}
          onEscapeKeyDown={(event) => { if (required) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (required) event.preventDefault(); }}>
          <div className={styles.heading}>
            <Dialog.Title className={overlay.dialogTitle}>{required ? 'Replace your temporary password' : 'Change password'}</Dialog.Title>
            <Dialog.Description className={overlay.dialogBody}>
              {required ? 'You must choose a private password before using CommitteeFlow.' : 'Enter your current password, then choose a new one.'}
            </Dialog.Description>
          </div>
          <form className={styles.form} onSubmit={submit} noValidate>
            {message && <div className={styles.alert} role="alert"><AlertCircle size={15} /><span>{message}</span></div>}
            {!required && (
              <PasswordInput
                label="Current password"
                value={currentPassword}
                revealed={revealed.current}
                autoComplete="current-password"
                autoFocus
                onChange={setCurrentPassword}
                onToggle={() => setRevealed((value) => ({ ...value, current: !value.current }))}
              />
            )}
            <PasswordInput
              label="New password"
              value={newPassword}
              revealed={revealed.new}
              autoComplete="new-password"
              autoFocus={required}
              onChange={setNewPassword}
              onToggle={() => setRevealed((value) => ({ ...value, new: !value.new }))}
            />
            <ul className={styles.rules} aria-label="Password rules">{RULES.map(([label, test]) => <li key={label} className={test(newPassword) ? styles.ruleMet : undefined}><Check size={12} />{label}</li>)}</ul>
            <PasswordInput
              label="Confirm new password"
              value={confirmPassword}
              revealed={revealed.confirm}
              autoComplete="new-password"
              onChange={setConfirmPassword}
              onToggle={() => setRevealed((value) => ({ ...value, confirm: !value.confirm }))}
            />
            <div className={overlay.dialogActions}>
              {!required && <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>}
              <Button type="submit" variant="primary" loading={change.isPending}>Update password</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PasswordInput({
  label,
  value,
  revealed,
  autoComplete,
  autoFocus = false,
  onChange,
  onToggle,
}: {
  label: string;
  value: string;
  revealed: boolean;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onToggle: () => void;
}) {
  const action = revealed ? 'Hide' : 'Show';

  return (
    <Field label={label}>
      {(props) => (
        <div className={styles.passwordField}>
          <input
            {...props}
            className={cn(controlClass, styles.passwordInput)}
            type={revealed ? 'text' : 'password'}
            autoComplete={autoComplete}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            autoFocus={autoFocus}
          />
          <button
            type="button"
            className={styles.reveal}
            onClick={onToggle}
            aria-pressed={revealed}
            aria-label={`${action} ${label.toLowerCase()}`}
            title={`${action} ${label.toLowerCase()}`}
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      )}
    </Field>
  );
}
