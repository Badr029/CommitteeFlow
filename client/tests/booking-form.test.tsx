import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingDrawer } from '@/features/bookings/BookingDrawer';
import {
  ApiStub,
  booking,
  defaultPlanFields,
  planField,
  renderWithProviders,
  session,
} from './harness';

/**
 * Spec §71 (frontend): dynamic fields, stale-edit conflict, read-only mode.
 * Spec §35, §77: one configuration drives the form.
 */
describe('Booking form', () => {
  let api: ApiStub;

  beforeEach(() => {
    api = new ApiStub();
  });

  function stub(options: { fields?: ReturnType<typeof planField>[]; sessionBookings?: unknown[] } = {}) {
    api
      .on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER') })
      .on('GET', '/api/plan-fields', { body: { fields: options.fields ?? defaultPlanFields() } })
      .on('GET', '/api/bookings/session-preview', {
        body: {
          bookingDate: '2026-09-09',
          bookingTime: '09:00',
          committee: 'North Committee',
          count: (options.sessionBookings ?? []).length,
          bookings: options.sessionBookings ?? [],
        },
      });
    api.install();
  }

  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/OFF No\./), '202601066');
    await user.type(screen.getByLabelText(/Order Name/), 'Transformer 2B');
    await user.type(screen.getByLabelText(/^Committee/), 'North Committee');
  }

  describe('generated from the plan configuration', () => {
    it('renders a control for every visible field, in order', async () => {
      stub();
      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      await screen.findByLabelText(/OFF No\./);
      // Anchored, because several labels share a prefix ("Committee" also
      // appears in the drawer's subtitle).
      for (const label of ['Date', 'Time', 'OFF No\\.', 'Order Name', 'Committee', 'Qty', 'Notes']) {
        expect(screen.getByLabelText(new RegExp(`^${label}`))).toBeInTheDocument();
      }
    });

    it('picks the control from the configured type', async () => {
      const fields = [
        ...defaultPlanFields(),
        planField({
          fieldKey: 'inspection_type',
          label: 'Inspection Type',
          fieldType: 'SELECT',
          options: ['Routine', 'Witness'],
          fieldClass: 'CUSTOM',
          storageStrategy: 'CUSTOM_JSONB',
        }),
        planField({
          fieldKey: 'witnessed',
          label: 'Witnessed',
          fieldType: 'CHECKBOX',
          fieldClass: 'CUSTOM',
          storageStrategy: 'CUSTOM_JSONB',
        }),
      ];
      stub({ fields });
      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      const select = await screen.findByLabelText(/Inspection Type/);
      expect(select.tagName).toBe('SELECT');
      expect(screen.getByRole('option', { name: 'Witness' })).toBeInTheDocument();

      expect(screen.getByLabelText(/Witnessed/)).toHaveAttribute('type', 'checkbox');
      expect(screen.getByLabelText(/^Qty/)).toHaveAttribute('type', 'number');
      expect(screen.getByLabelText(/^Date/)).toHaveAttribute('type', 'date');
      expect(screen.getByLabelText(/^Time/)).toHaveAttribute('type', 'time');
    });

    it('marks required fields and labels optional ones', async () => {
      stub();
      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      await screen.findByLabelText(/OFF No\./);
      // Requiredness comes from the configuration, and reaches assistive
      // technology through the control rather than the decorative asterisk.
      expect(screen.getByLabelText(/^OFF No\./)).toHaveAttribute('aria-required', 'true');
      expect(screen.getByLabelText(/^Qty/)).not.toHaveAttribute('aria-required');
      expect(screen.getAllByText('optional').length).toBeGreaterThan(0);
    });

    it('defaults the date to the month being viewed, not to today', async () => {
      stub();
      renderWithProviders(
        <BookingDrawer open mode="create" month="2027-03" onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      const date = await screen.findByLabelText(/^Date/);
      expect(date).toHaveValue('2027-03-01');
    });
  });

  describe('shared committee sessions (spec §46, §78.1 — confirmed)', () => {
    it('states what is already in the session without blocking', async () => {
      stub({
        sessionBookings: [
          {
            id: 'b1',
            offNo: '202601066',
            orderName: 'Transformer 2B',
            customerName: 'Aweer',
            status: 'Planned',
            createdBy: { id: 'u1', name: 'Ahmed Hassan', email: 'a@x.test' },
          },
          {
            id: 'b2',
            offNo: '202501261',
            orderName: 'HV Cable Box',
            customerName: null,
            status: null,
            createdBy: { id: 'u1', name: 'Ahmed Hassan', email: 'a@x.test' },
          },
        ],
      });

      renderWithProviders(
        <BookingDrawer
          open
          mode="create"
          month="2026-09"
          prefill={{ booking_date: '2026-09-09', booking_time: '09:00', committee: 'North Committee' }}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      expect(
        await screen.findByText('2 projects are already in this session'),
      ).toBeInTheDocument();
      expect(screen.getByText('Adding another project to this session is normal.')).toBeInTheDocument();
      expect(screen.getByText('Transformer 2B')).toBeInTheDocument();
      // The primary action stays enabled — a shared session is not a conflict.
      expect(screen.getByRole('button', { name: 'Book slot' })).toBeEnabled();
    });

    it('says nothing when the session is empty', async () => {
      stub({ sessionBookings: [] });
      renderWithProviders(
        <BookingDrawer
          open
          mode="create"
          month="2026-09"
          prefill={{ booking_date: '2026-09-09', booking_time: '09:00' }}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      await screen.findByLabelText(/OFF No\./);
      await waitFor(() => {
        expect(screen.queryByText(/already in this session/)).not.toBeInTheDocument();
      });
    });
  });

  describe('saving', () => {
    it('sends only the configured values and the CSRF token', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      stub();
      api.on('POST', '/api/bookings', { status: 201, body: booking() });

      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={vi.fn()} onSaved={onSaved} />,
      );

      await screen.findByLabelText(/OFF No\./);
      await user.type(screen.getByLabelText(/^Time/), '09:00');
      await fillRequired(user);
      await user.click(screen.getByRole('button', { name: 'Book slot' }));

      await waitFor(() => expect(onSaved).toHaveBeenCalled());

      const post = api.calls.find((call) => call.method === 'POST');
      expect(post?.csrf).toBe('test-csrf-token');
      const values = (post?.body as { values: Record<string, unknown> }).values;
      expect(values).toMatchObject({
        booking_date: '2026-09-01',
        off_no: '202601066',
        order_name: 'Transformer 2B',
        committee: 'North Committee',
      });
      // Untouched optional fields are omitted rather than sent as null.
      expect(values).not.toHaveProperty('qty');
      expect(values).not.toHaveProperty('notes');
    });

    it('attaches server validation messages to their own fields', async () => {
      const user = userEvent.setup();
      stub();
      api.on('POST', '/api/bookings', {
        status: 422,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some fields need attention.',
            issues: [{ field: 'qty', message: 'Qty must be greater than zero.' }],
          },
        },
      });

      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      await screen.findByLabelText(/OFF No\./);
      await user.type(screen.getByLabelText(/^Time/), '09:00');
      await fillRequired(user);
      await user.click(screen.getByRole('button', { name: 'Book slot' }));

      const error = await screen.findByRole('alert');
      expect(error).toHaveTextContent('Qty must be greater than zero.');
      expect(screen.getByLabelText(/^Qty/)).toHaveAttribute('aria-invalid', 'true');
    });

    it('sends only what changed on an edit, with the version it was opened at', async () => {
      const user = userEvent.setup();
      const existing = booking({ qty: 3, version: 4 });
      stub();
      api.on('PATCH', '/api/bookings/', { body: { ...existing, qty: 9, version: 5 } });

      renderWithProviders(
        <BookingDrawer open mode="edit" booking={existing} onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      const qty = await screen.findByLabelText(/^Qty/);
      await user.clear(qty);
      await user.type(qty, '9');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true));
      const patch = api.calls.find((call) => call.method === 'PATCH');
      const body = patch?.body as { version: number; values: Record<string, unknown> };
      expect(body.version).toBe(4);
      expect(body.values).toEqual({ qty: 9 });
    });

    it('reports a stale edit as a conflict the user can act on (spec §48)', async () => {
      const user = userEvent.setup();
      const existing = booking({ version: 3 });
      stub();
      api.on('PATCH', '/api/bookings/', {
        status: 409,
        body: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'This booking was changed by another user. Refresh before saving.',
            currentVersion: 4,
          },
        },
      });

      renderWithProviders(
        <BookingDrawer open mode="edit" booking={existing} onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      const qty = await screen.findByLabelText(/^Qty/);
      await user.clear(qty);
      await user.type(qty, '7');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('This booking was not saved');
      expect(alert).toHaveTextContent('changed by another user');
    });

    it('warns before discarding unsaved changes', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      stub();

      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={onClose} onSaved={vi.fn()} />,
      );

      await screen.findByLabelText(/OFF No\./);
      await user.type(screen.getByLabelText(/OFF No\./), '2026');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByText('Discard this booking?')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(onClose).toHaveBeenCalled();
    });

    it('closes straight away when nothing was typed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      stub();

      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={onClose} onSaved={vi.fn()} />,
      );

      await screen.findByLabelText(/OFF No\./);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onClose).toHaveBeenCalled();
      expect(screen.queryByText('Discard this booking?')).not.toBeInTheDocument();
    });

    it('shows a skeleton of the form while the configuration loads', () => {
      stub();
      renderWithProviders(
        <BookingDrawer open mode="create" month="2026-09" onClose={vi.fn()} onSaved={vi.fn()} />,
      );

      expect(screen.getByLabelText('Loading the booking form')).toBeInTheDocument();
    });
  });
});
