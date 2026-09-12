import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Check, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '@/api/client';
import { useChangePassword } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
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
  const [clientError, setClientError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missingRule = RULES.some(([, test]) => !test(newPassword));
    if (missingRule) { setClientError('Your new password must meet every rule below.'); return; }
    if (newPassword !== confirmPassword) { setClientError('The new passwords do not match.'); return; }
    if (newPassword === currentPassword) { setClientError('Choose a password different from your current password.'); return; }
    setClientError(null);
    change.mutate({ currentPassword, newPassword }, {
      onSuccess: () => {
        setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
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
            {!required && <Dialog.Close asChild><Button variant="ghost" iconOnly icon={<X size={15} />} aria-label="Close" /></Dialog.Close>}
          </div>
          <form className={styles.form} onSubmit={submit} noValidate>
            {message && <div className={styles.alert} role="alert"><AlertCircle size={15} /><span>{message}</span></div>}
            <Field label="Current password">{(props) => <input {...props} className={controlClass} type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoFocus />}</Field>
            <Field label="New password">{(props) => <input {...props} className={controlClass} type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />}</Field>
            <ul className={styles.rules} aria-label="Password rules">{RULES.map(([label, test]) => <li key={label} className={test(newPassword) ? styles.ruleMet : undefined}><Check size={12} />{label}</li>)}</ul>
            <Field label="Confirm new password">{(props) => <input {...props} className={controlClass} type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />}</Field>
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
