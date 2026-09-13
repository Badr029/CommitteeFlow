import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { AppBooting } from '@/features/auth/AppBooting';
import { PasswordChangeDialog } from '@/features/auth/PasswordChangeDialog';
import { ApiStub, renderWithProviders, session } from './harness';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}

describe('authentication routing and temporary passwords', () => {
  it('uses a login-shaped boot screen without exposing the plan skeleton', () => {
    renderWithProviders(<AppBooting />, '/');
    const loading = screen.getByLabelText('Loading sign in');
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/Loading plan/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
  });

  it('returns to the exact protected page requested before sign-in', async () => {
    const signedIn = session('PROJECT_ENGINEER');
    let sessionReads = 0;
    const api = new ApiStub();
    api.on('GET', '/api/auth/session', () => sessionReads++ === 0
        ? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } } }
        : { body: signedIn })
      .on('POST', '/api/auth/login', { body: signedIn })
      .on('GET', '/api/activity', { body: { items: [], page: 1, limit: 50, total: 0 } })
      .install();
    const user = userEvent.setup();

    renderWithProviders(<><App /><LocationProbe /></>, '/activity?page=2');
    await screen.findByRole('heading', { name: 'Committee Plan' });
    await user.type(screen.getByLabelText('Email address'), 'ahmed@example.test');
    await user.type(screen.getByLabelText('Password'), 'Temporary!123');
    await user.click(screen.getByRole('checkbox', { name: /Keep me signed in/i }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent('/activity?page=2'));
    expect(api.calls.find((call) => call.url === '/api/auth/login')?.body).toEqual({
      email: 'ahmed@example.test',
      password: 'Temporary!123',
      rememberMe: true,
    });
  });

  it('requires a script-created user to replace the temporary password', async () => {
    const temporary = session('PROJECT_ENGINEER');
    temporary.user.mustChangePassword = true;
    const changed = session('PROJECT_ENGINEER');
    let passwordChanged = false;
    const api = new ApiStub()
      .on('GET', '/api/auth/session', () => ({ body: passwordChanged ? changed : temporary }))
      .on('POST', '/api/auth/change-password', () => { passwordChanged = true; return { body: changed }; });
    api.install();
    const user = userEvent.setup();

    renderWithProviders(<App />, '/missing');
    const dialog = await screen.findByRole('dialog', { name: 'Replace your temporary password' });
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    const newPassword = screen.getByLabelText('New password');
    expect(newPassword).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show new password' }));
    expect(newPassword).toHaveAttribute('type', 'text');

    await user.type(newPassword, 'PrivateStrong!456');
    await user.type(screen.getByLabelText('Confirm new password'), 'PrivateStrong!456');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls.find((call) => call.url === '/api/auth/change-password')?.body).toEqual({
      newPassword: 'PrivateStrong!456',
    });
  });

  it('keeps current-password verification and Cancel for a normal password change', () => {
    new ApiStub().install();
    renderWithProviders(
      <PasswordChangeDialog open required={false} onOpenChange={vi.fn()} />,
      '/plan',
    );

    expect(screen.getByLabelText('Current password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });
});
