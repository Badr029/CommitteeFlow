import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanConfigPage } from '@/features/plan-config/PlanConfigPage';
import {
  ApiStub,
  defaultPlanFields,
  renderWithProviders,
  session,
} from './harness';

/**
 * Renaming a plan field (spec §19–§25).
 *
 * A typed label used to save the moment the input lost focus — clicking
 * anywhere else on the page committed a change nobody had explicitly asked to
 * commit. It is a draft now: a PATCH only ever follows an explicit accept.
 */
describe('Plan Configuration — renaming a field', () => {
  let api: ApiStub;

  beforeEach(() => {
    api = new ApiStub();
  });

  function stubConfig() {
    const fields = defaultPlanFields();
    api
      .on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER', true) })
      .on('GET', '/api/plan-fields/history?page=1&limit=25', {
        body: { entries: [], page: 1, limit: 25, total: 0, hasMore: false },
      })
      .on('GET', '/api/plan-fields', { body: { fields } })
      .on('GET', '/api/settings', { body: session('PROJECT_ENGINEER', true).settings })
      .on('GET', '/api/users?page=1&limit=25', {
        body: { users: [], page: 1, limit: 25, total: 0, managerCount: 0, hasMore: false },
      });
    api.install();
    return fields;
  }

  it('does not save on blur — typing and clicking away leaves the label untouched', async () => {
    const user = userEvent.setup();
    stubConfig();
    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    const input = await screen.findByLabelText('Label for off_no');
    await user.clear(input);
    await user.type(input, 'Offer Number');
    await user.click(document.body);

    // Give any stray request a moment to have fired before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(input).toHaveValue('Offer Number');
  });

  it('shows accept and discard controls only while the label is a draft', async () => {
    const user = userEvent.setup();
    stubConfig();
    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    const input = await screen.findByLabelText('Label for off_no');
    expect(screen.queryByLabelText('Accept the new label for off_no')).not.toBeInTheDocument();

    await user.type(input, 'X');
    expect(screen.getByLabelText('Accept the new label for off_no')).toBeInTheDocument();
    expect(screen.getByLabelText('Discard the new label for off_no')).toBeInTheDocument();
  });

  it('applies the rename once Accept is pressed', async () => {
    const user = userEvent.setup();
    const fields = stubConfig();
    const target = fields.find((field) => field.fieldKey === 'off_no')!;
    api.on('PATCH', `/api/plan-fields/${target.id}`, {
      body: { ...target, label: 'Offer Number' },
    });

    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    const input = await screen.findByLabelText('Label for off_no');
    await user.clear(input);
    await user.type(input, 'Offer Number');
    await user.click(screen.getByLabelText('Accept the new label for off_no'));

    await waitFor(() => {
      expect(
        api.calls.some(
          (call) => call.method === 'PATCH' && call.url.endsWith(`/api/plan-fields/${target.id}`),
        ),
      ).toBe(true);
    });
  });

  it('discards the draft and restores the saved label on Cancel', async () => {
    const user = userEvent.setup();
    stubConfig();
    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    const input = await screen.findByLabelText('Label for off_no');
    await user.clear(input);
    await user.type(input, 'Offer Number');
    await user.click(screen.getByLabelText('Discard the new label for off_no'));

    expect(input).toHaveValue('OFF No.');
    expect(screen.queryByLabelText('Accept the new label for off_no')).not.toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('accepts a draft submitted with Enter', async () => {
    const user = userEvent.setup();
    const fields = stubConfig();
    const target = fields.find((field) => field.fieldKey === 'off_no')!;
    api.on('PATCH', `/api/plan-fields/${target.id}`, {
      body: { ...target, label: 'Offer Number' },
    });

    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    const input = await screen.findByLabelText('Label for off_no');
    await user.clear(input);
    await user.type(input, 'Offer Number{Enter}');

    await waitFor(() => {
      expect(
        api.calls.some(
          (call) => call.method === 'PATCH' && call.url.endsWith(`/api/plan-fields/${target.id}`),
        ),
      ).toBe(true);
    });
  });

  it('discards the draft on Escape without saving', async () => {
    const user = userEvent.setup();
    stubConfig();
    renderWithProviders(<PlanConfigPage />, '/plan-configuration');

    const input = await screen.findByLabelText('Label for off_no');
    await user.clear(input);
    await user.type(input, 'Offer Number{Escape}');

    expect(input).toHaveValue('OFF No.');
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});
