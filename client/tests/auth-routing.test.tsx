import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { AppBooting } from '@/features/auth/AppBooting';
import { ApiStub, renderWithProviders, session } from './harness';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}

describe('authentication routing and temporary passwords', () => {
  it('uses a login-shaped boot screen without exposing the plan skeleton', () => {
    renderWithProviders(<AppBooting />, '/');
    expect(screen.getByLabelText('Loading CommitteeFlow')).toBeInTheDocument();
    expect(screen.queryByText(/Loading plan/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
  });

  it('returns to the exact protected page requested before sign-in', async () => {
    const signedIn = session('PROJECT_ENGINEER');
    let sessionReads = 0;
    new ApiStub()
      .on('GET', '/api/auth/session', () => sessionReads++ === 0
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
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByLabelText('Current route')).toHaveTextContent('/activity?page=2'));
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

    await user.type(screen.getByLabelText('Current password'), 'Temporary!123');
    await user.type(screen.getByLabelText('New password'), 'PrivateStrong!456');
    await user.type(screen.getByLabelText('Confirm new password'), 'PrivateStrong!456');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls.find((call) => call.url === '/api/auth/change-password')?.body).toEqual({
      currentPassword: 'Temporary!123',
      newPassword: 'PrivateStrong!456',
    });
  });
});
