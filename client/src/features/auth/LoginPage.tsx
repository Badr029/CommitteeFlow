import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { AlertCircle, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { ApiError } from '@/api/client';
import { useLogin } from '@/api/queries';
import type { Theme } from '@/lib/theme';
import { BrandMark } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { controlClass } from '@/components/ui/classes';
import { cn } from '@/lib/cn';
import styles from './LoginPage.module.css';

/**
 * Sign in.
 *
 * The server answers a wrong password and an unknown address identically, so
 * this screen shows exactly what it is given and never guesses which of the two
 * fields was wrong.
 *
 * The credentials are read from the form on submit rather than from React
 * state. A password manager filling both fields does not reliably fire React's
 * synthetic `change`, so state-derived values can still be empty while the
 * inputs visibly hold text — which is how a "Sign in" button ends up refusing
 * to do anything until the user pokes a field. The form element always knows
 * what is actually in it.
 */
export function LoginPage({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) return;

    const data = new FormData(event.currentTarget);
    const submittedEmail = String(data.get('email') ?? '').trim();
    const submittedPassword = String(data.get('password') ?? '');

    if (!submittedEmail || !submittedPassword) {
      setMissing(
        !submittedEmail && !submittedPassword
          ? 'Enter your email address and password.'
          : !submittedEmail
            ? 'Enter your email address.'
            : 'Enter your password.',
      );
      return;
    }

    setMissing(null);
    login.mutate(
      { email: submittedEmail, password: submittedPassword },
      {
        onSuccess: (session) => {
          toast.success(`Signed in as ${session.user.name}`, {
            description:
              session.user.role === 'PROJECT_ENGINEER'
                ? 'You can book and change committee slots.'
                : 'You have read-only access to the plan.',
          });
        },
      },
    );
  };

  const serverError = login.error instanceof ApiError ? login.error : null;
  const message = missing ?? serverError?.message ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.topline}>
        <BrandMark />
        <span className={styles.brandName}>CommitteeFlow</span>
        <span className={styles.toplineSpacer} />
        <Button
          variant="ghost"
          iconOnly
          icon={theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        />
      </header>

      <div className={styles.center}>
        <div className={styles.panel}>
          <div className={styles.heading}>
            <h1 className={styles.title}>Committee Plan</h1>
            <p className={styles.blurb}>
              One live plan for committee bookings, shared by everyone. Sign in with your work
              email address.
            </p>
          </div>

          <form className={styles.form} onSubmit={submit} noValidate>
            {message && (
              <div className={styles.alert} role="alert">
                <AlertCircle size={15} className={styles.alertIcon} aria-hidden="true" />
                <span>{message}</span>
              </div>
            )}

            <Field label="Email address">
              {(props) => (
                <input
                  {...props}
                  className={controlClass}
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoFocus
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@elsewedy.example"
                />
              )}
            </Field>

            <Field label="Password">
              {(props) => (
                <div className={styles.passwordField}>
                  <input
                    {...props}
                    className={cn(controlClass, styles.passwordInput)}
                    type={revealed ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {/*
                    * `aria-pressed` rather than a label that changes meaning:
                    * this is a toggle, and a screen reader should hear its
                    * state, not have to infer it from the icon.
                    */}
                  <button
                    type="button"
                    className={styles.reveal}
                    onClick={() => setRevealed((current) => !current)}
                    aria-pressed={revealed}
                    aria-label={revealed ? 'Hide password' : 'Show password'}
                    title={revealed ? 'Hide password' : 'Show password'}
                  >
                    {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              )}
            </Field>

            {/*
              * Never disabled on emptiness. A disabled control cannot explain
              * itself, and with an autofilled form it is simply wrong.
              */}
            <Button type="submit" variant="primary" size="large" loading={login.isPending}>
              Sign in
            </Button>
          </form>
        </div>
      </div>

      <footer className={styles.foot}>
        Replaces the monthly Committee Plan spreadsheet. Ask your plan administrator for access.
      </footer>
    </div>
  );
}
