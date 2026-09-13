import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PlanConfigPage } from '@/features/plan-config/PlanConfigPage';
import { ApiStub, defaultPlanFields, renderWithProviders, session } from './harness';

const account = (number: number) => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  name: `Account ${number}`,
  email: `account-${number}@example.test`,
  role: 'VIEWER' as const,
  canManagePlanConfiguration: number <= 4,
});

const historyEntry = (number: number) => ({
  id: number,
  fieldKey: `field_${number}`,
  action: 'CREATE' as const,
  oldValue: null,
  newValue: { label: `History ${number}` },
  changedBy: { id: account(1).id, name: 'Plan Manager', email: 'manager@example.test' },
  changedAt: '2026-09-13T10:00:00.000Z',
});

describe('Plan Configuration pagination', () => {
  it('pages accounts and configuration history independently', async () => {
    const api = new ApiStub();
    api
      .on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER', true) })
      .on('GET', '/api/plan-fields/history?page=1&limit=25', {
        body: { entries: Array.from({ length: 25 }, (_, index) => historyEntry(index + 1)), page: 1, limit: 25, total: 26, hasMore: true },
      })
      .on('GET', '/api/plan-fields/history?page=2&limit=25', {
        body: { entries: [historyEntry(26)], page: 2, limit: 25, total: 26, hasMore: false },
      })
      .on('GET', '/api/plan-fields', { body: { fields: defaultPlanFields() } })
      .on('GET', '/api/settings', { body: session('PROJECT_ENGINEER', true).settings })
      .on('GET', '/api/users?page=1&limit=25', {
        body: { users: Array.from({ length: 25 }, (_, index) => account(index + 1)), page: 1, limit: 25, total: 26, managerCount: 4, hasMore: true },
      })
      .on('GET', '/api/users?page=2&limit=25', {
        body: { users: [account(26)], page: 2, limit: 25, total: 26, managerCount: 4, hasMore: false },
      });
    api.install();
    const user = userEvent.setup();

    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    expect(await screen.findByText('4 of 26 accounts')).toBeInTheDocument();
    expect(screen.getAllByText('1–25 of 26')).toHaveLength(2);
    expect(screen.getAllByText('Page 1 of 2')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Next accounts page' }));
    expect(await screen.findByText('Account 26')).toBeInTheDocument();
    expect(screen.getByText('26–26 of 26')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next configuration history entries page' }));
    expect(await screen.findByText(/added the field “History 26”/)).toBeInTheDocument();

    await waitFor(() => {
      expect(api.calls.some((call) => call.url === '/api/users?page=2&limit=25')).toBe(true);
      expect(api.calls.some((call) => call.url === '/api/plan-fields/history?page=2&limit=25')).toBe(true);
    });
  });
});
