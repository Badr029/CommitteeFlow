import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPage } from '@/features/plan/PlanPage';
import { groupIntoDays, tableColumns } from '@/features/plan/sessions';
import {
  ApiStub,
  booking,
  bookingListResponse,
  defaultPlanFields,
  planField,
  renderWithProviders,
  session,
} from './harness';

/** Spec §71 (frontend): role-based UI, dynamic fields, month navigation, filters. */
describe('Committee Plan', () => {
  let api: ApiStub;

  beforeEach(() => {
    api = new ApiStub();
  });

  function stubPlan(options: {
    role?: 'PROJECT_ENGINEER' | 'VIEWER';
    canManage?: boolean;
    bookings?: ReturnType<typeof booking>[];
    fields?: ReturnType<typeof planField>[];
  } = {}) {
    const bookings = options.bookings ?? [
      booking({ offNo: 'A1', orderName: 'Transformer 2B', bookingTime: '09:00' }),
      booking({ offNo: 'A2', orderName: 'HV Cable Box', bookingTime: '09:00' }),
      booking({
        offNo: 'B1',
        orderName: 'Feeder Pillar',
        bookingTime: '13:00',
        committee: 'South Committee',
      }),
    ];

    api
      .on('GET', '/api/auth/session', {
        body: session(options.role ?? 'PROJECT_ENGINEER', options.canManage ?? false),
      })
      .on('GET', '/api/plan-fields', { body: { fields: options.fields ?? defaultPlanFields() } })
      .on('GET', '/api/settings', { body: session('VIEWER').settings })
      .on('GET', '/api/bookings', { body: bookingListResponse(bookings) });
    api.install();
    return bookings;
  }

  describe('session grouping (spec §46, §78.1 — confirmed)', () => {
    it('groups the plan into days and shared committee sessions', async () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');

      // 09 September holds two sessions: 09:00 North (2 projects) and 13:00 South.
      expect(screen.getByText('09 September')).toBeInTheDocument();
      expect(screen.getByText('2 projects')).toBeInTheDocument();
      expect(screen.getAllByText('1 project').length).toBeGreaterThan(0);
      // The summary interleaves figures and words across elements.
      const summary = screen.getByText((_text, element) =>
        (element?.textContent ?? '').replace(/\s+/g, ' ').trim() === '3 projects in 2 sessions',
      );
      expect(summary).toBeInTheDocument();
    });

    it('places several projects under one time and committee', () => {
      const days = groupIntoDays([
        booking({ offNo: 'A1', bookingTime: '09:00', committee: 'North Committee' }),
        booking({ offNo: 'A2', bookingTime: '09:00', committee: 'North Committee' }),
        booking({ offNo: 'A3', bookingTime: '09:00', committee: 'South Committee' }),
      ]);

      expect(days).toHaveLength(1);
      expect(days[0]?.sessions).toHaveLength(2);
      expect(days[0]?.sessions[0]?.bookings.map((b) => b.offNo)).toEqual(['A1', 'A2']);
      expect(days[0]?.sessions[1]?.bookings.map((b) => b.offNo)).toEqual(['A3']);
      expect(days[0]?.bookingCount).toBe(3);
    });

    it('starts a new session when the committee changes at the same time', () => {
      const days = groupIntoDays([
        booking({ bookingTime: '09:00', committee: 'North Committee' }),
        booking({ bookingTime: '09:00', committee: null }),
      ]);
      expect(days[0]?.sessions).toHaveLength(2);
    });
  });

  describe('dynamic columns (spec §35, §77)', () => {
    it('renders the configured labels in the configured order', async () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');
      const headers = screen.getAllByRole('columnheader').map((el) => el.textContent);
      expect(headers).toEqual([
        'OFF No.',
        'Order Name',
        'Qty',
        'KVA',
        'KV',
        'Status',
        'Serial No.',
        'Project Engineer',
        'Notes',
        'Customer Name',
      ]);
    });

    it('follows a rename with no code change', async () => {
      const fields = defaultPlanFields().map((field) =>
        field.fieldKey === 'customer_name' ? { ...field, label: 'Client Name' } : field,
      );
      stubPlan({ fields });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');
      expect(screen.getByRole('columnheader', { name: 'Client Name' })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Customer Name' })).not.toBeInTheDocument();
    });

    it('drops a hidden field from the table', async () => {
      const fields = defaultPlanFields().map((field) =>
        field.fieldKey === 'kva' ? { ...field, isVisible: false } : field,
      );
      stubPlan({ fields });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');
      expect(screen.queryByRole('columnheader', { name: 'KVA' })).not.toBeInTheDocument();
    });

    it('shows a custom field once it is configured', async () => {
      const fields = [
        ...defaultPlanFields(),
        planField({
          fieldKey: 'project_manager',
          label: 'Project Manager',
          fieldClass: 'CUSTOM',
          storageStrategy: 'CUSTOM_JSONB',
          displayOrder: 200,
        }),
      ];
      stubPlan({
        fields,
        bookings: [booking({ customFields: { project_manager: 'Mohamed Ali' } })],
      });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByRole('columnheader', { name: 'Project Manager' });
      expect(screen.getByText('Mohamed Ali')).toBeInTheDocument();
    });

    it('excludes date, time and committee — they head the group instead', () => {
      const columns = tableColumns(defaultPlanFields()).map((field) => field.fieldKey);
      expect(columns).not.toContain('booking_date');
      expect(columns).not.toContain('booking_time');
      expect(columns).not.toContain('committee');
    });
  });

  describe('role-based UI (spec §4, §41)', () => {
    it('offers booking controls to a Project Engineer', async () => {
      stubPlan({ role: 'PROJECT_ENGINEER' });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');
      expect(screen.getByRole('button', { name: /Book Committee Slot/ })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Add to this session/ }).length).toBeGreaterThan(0);
    });

    it('hides every write control from a Viewer', async () => {
      stubPlan({ role: 'VIEWER' });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');
      expect(screen.queryByRole('button', { name: /Book Committee Slot/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Add to this session/ })).not.toBeInTheDocument();
      // Reading and exporting stay available.
      expect(screen.getByRole('button', { name: /Excel/ })).toBeInTheDocument();
    });
  });

  describe('month navigation (spec §8, §9)', () => {
    it('shows the requested month and steps forwards and backwards', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      await screen.findByText('Transformer 2B');
      expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Oct 2026/ }));
      await screen.findByRole('heading', { name: 'October 2026' });

      // The steppers always name the months either side of the current one.
      await user.click(await screen.findByRole('button', { name: /Sep 2026/ }));
      await screen.findByRole('heading', { name: 'September 2026' });
    });

    it('lets a Project Engineer reach a future month', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.click(screen.getByRole('button', { name: /Oct 2026/ }));
      await user.click(await screen.findByRole('button', { name: /Nov 2026/ }));

      await screen.findByRole('heading', { name: 'November 2026' });
      const monthCalls = api.calls.filter((call) => call.url.includes('/api/bookings?month='));
      expect(monthCalls.some((call) => call.url.includes('month=2026-11'))).toBe(true);
    });
  });

  describe('filters (spec §6)', () => {
    it('sends the committee filter to the server', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.selectOptions(
        screen.getByRole('combobox', { name: /filter by committee/i }),
        'South Committee',
      );

      await waitFor(() => {
        expect(
          api.calls.some((call) => call.url.includes('committee=South+Committee')),
        ).toBe(true);
      });
    });

    it('treats "only my bookings" as a filter, not a page', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.click(screen.getByLabelText(/only my bookings/i));

      await waitFor(() => {
        // By the engineer whose projects they are, not by who typed the rows.
        expect(api.calls.some((call) => call.url.includes('projectEngineer=user-1'))).toBe(true);
      });
    });

    it('asks for cancelled bookings only when requested', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      expect(api.calls.every((call) => !call.url.includes('includeCancelled'))).toBe(true);

      await user.click(screen.getByLabelText(/show cancelled/i));
      await waitFor(() => {
        expect(api.calls.some((call) => call.url.includes('includeCancelled=true'))).toBe(true);
      });
    });
  });

  /*
   * Reading a busy month.
   *
   * The plan nests three levels — day, committee session, project — and the
   * complaint that produced these two features was losing track of which one a
   * line belonged to. Both are ways of reading what is already on screen, so
   * neither goes back to the server.
   */
  describe('reading a long month', () => {
    function threeDays() {
      return [
        booking({ offNo: 'A1', orderName: 'Transformer 2B', bookingDate: '2026-09-09' }),
        booking({ offNo: 'B1', orderName: 'Feeder Pillar', bookingDate: '2026-09-10' }),
        booking({ offNo: 'C1', orderName: 'GIS Bay Extension', bookingDate: '2026-09-13' }),
      ];
    }

    it('narrows the plan to one day of the month', async () => {
      const user = userEvent.setup();
      stubPlan({ bookings: threeDays() });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      const before = api.calls.length;
      await user.selectOptions(
        screen.getByRole('combobox', { name: /filter by day of the month/i }),
        '2026-09-10',
      );

      expect(await screen.findByText('Feeder Pillar')).toBeInTheDocument();
      expect(screen.queryByText('Transformer 2B')).not.toBeInTheDocument();
      expect(screen.queryByText('GIS Bay Extension')).not.toBeInTheDocument();

      // The month is already loaded, so this is reading, not re-fetching.
      expect(api.calls.length).toBe(before);
    });

    it('offers only the days the month actually has bookings on', async () => {
      stubPlan({ bookings: threeDays() });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      const options = within(
        screen.getByRole('combobox', { name: /filter by day of the month/i }),
      ).getAllByRole('option');

      expect(options.map((option) => option.textContent)).toEqual([
        'Day: all',
        // The weekday comes from the booking's own `displayDay` (§9), which the
        // stub fixes, so all three read the same here.
        '09 September · Wednesday',
        '10 September · Wednesday',
        '13 September · Wednesday',
      ]);
    });

    it('drops the day filter when the month changes', async () => {
      const user = userEvent.setup();
      stubPlan({ bookings: threeDays() });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.selectOptions(
        screen.getByRole('combobox', { name: /filter by day of the month/i }),
        '2026-09-10',
      );
      await screen.findByText('Feeder Pillar');

      // 2026-09-10 means nothing in October.
      await user.click(screen.getByRole('button', { name: /Oct 2026/ }));
      await screen.findByRole('heading', { name: 'October 2026' });

      expect(
        screen.getByRole('combobox', { name: /filter by day of the month/i }),
      ).toHaveValue('');
    });

    it('says a chosen day is free rather than falling back to the month', async () => {
      const user = userEvent.setup();
      stubPlan({ bookings: threeDays() });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.selectOptions(
        screen.getByRole('combobox', { name: /filter by day of the month/i }),
        '2026-09-10',
      );
      await screen.findByText('Feeder Pillar');
      expect(screen.queryByText('Transformer 2B')).not.toBeInTheDocument();
    });

    it('minimises a day, and says how much it is hiding', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.click(screen.getByRole('button', { name: 'Minimise 09 September' }));

      expect(screen.queryByText('Transformer 2B')).not.toBeVisible();
      // The heading keeps its count, so minimising never hides the total.
      expect(screen.getByText(/2 sessions/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Expand 09 September' }));
      expect(screen.getByText('Transformer 2B')).toBeVisible();
    });

    it('minimises one committee session without touching its neighbours', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.click(screen.getByRole('button', { name: /Minimise 09:00 North Committee/ }));

      expect(screen.queryByText('Transformer 2B')).not.toBeVisible();
      expect(screen.getByText('Feeder Pillar')).toBeVisible();
    });

    it('remembers which sessions were folded when a day is reopened', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.click(screen.getByRole('button', { name: /Minimise 09:00 North Committee/ }));
      await user.click(screen.getByRole('button', { name: 'Minimise 09 September' }));
      await user.click(screen.getByRole('button', { name: 'Expand 09 September' }));

      // Reopening the day restores what was left, rather than resetting it.
      expect(screen.getByText('Feeder Pillar')).toBeVisible();
      expect(screen.queryByText('Transformer 2B')).not.toBeVisible();
    });
  });


  /*
   * Status, Serial No. and Project Engineer.
   *
   * The plan's Status column had been holding transformer serial numbers. These
   * cover what a reader now sees on the plan: a lifecycle with two values, the
   * serials in a column of their own, and whose project each row is.
   */
  describe('status, serial number and ownership', () => {
    it('shows a planned booking as Planned, not as PLANNED', async () => {
      stubPlan({ bookings: [booking({ offNo: 'X1' })] });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      const row = await screen.findByRole('row', { name: /Open booking X1/ });
      // The database's word is not the reader's.
      expect(within(row).getByText('Planned')).toBeInTheDocument();
      expect(within(row).queryByText('PLANNED')).not.toBeInTheDocument();
    });

    it('shows the serial number as written, leading zeros and all', async () => {
      stubPlan({
        bookings: [booking({ offNo: 'X1', serialNo: '010662606B-020662606B' })],
      });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      const row = await screen.findByRole('row', { name: /Open booking X1/ });
      expect(within(row).getByText('010662606B-020662606B')).toBeInTheDocument();
    });

    it('names the engineer whose project it is', async () => {
      stubPlan({ bookings: [booking({ offNo: 'X1' })] });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      const row = await screen.findByRole('row', { name: /Open booking X1/ });
      expect(within(row).getByText('Ahmed Hassan')).toBeInTheDocument();
    });

    it('says so plainly when nobody owns an imported booking', async () => {
      stubPlan({ bookings: [booking({ offNo: 'X1', projectEngineer: null })] });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      const row = await screen.findByRole('row', { name: /Open booking X1/ });
      // An em dash, the same as any other empty cell — not a guess at an owner.
      expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
    });

    it('strikes through only the cancelled booking in a shared session', async () => {
      stubPlan({
        bookings: [
          booking({ offNo: 'A1', orderName: 'Project A' }),
          booking({ offNo: 'B1', orderName: 'Project B', status: 'CANCELLED' }),
          booking({ offNo: 'C1', orderName: 'Project C' }),
        ],
      });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&cancelled=1');

      const cancelled = await screen.findByRole('row', { name: /Open booking B1/ });
      expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument();

      // The session is not cancelled just because one project in it is.
      const planned = screen.getByRole('row', { name: /Open booking A1/ });
      expect(within(planned).getByText('Planned')).toBeInTheDocument();
      expect(within(planned).queryByText('Cancelled')).not.toBeInTheDocument();
    });

    it('filters by the engineer a project belongs to', async () => {
      const user = userEvent.setup();
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');
      await screen.findByText('Transformer 2B');

      await user.selectOptions(
        screen.getByRole('combobox', { name: /filter by engineer/i }),
        'user-1',
      );

      await waitFor(() => {
        expect(api.calls.some((call) => call.url.includes('projectEngineer=user-1'))).toBe(true);
      });
    });
  });

  describe('states', () => {
    it('teaches the interface when the month is empty', async () => {
      stubPlan({ bookings: [] });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      expect(await screen.findByText(/No bookings in September 2026/)).toBeInTheDocument();
      expect(screen.getByText(/plan into a future month/i)).toBeInTheDocument();
    });

    it('tells a Viewer who will fill an empty month', async () => {
      stubPlan({ role: 'VIEWER', bookings: [] });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      expect(
        await screen.findByText(/When a Project Engineer books a slot/i),
      ).toBeInTheDocument();
    });

    it('offers a retry when the plan cannot be loaded', async () => {
      api
        .on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER') })
        .on('GET', '/api/plan-fields', { body: { fields: defaultPlanFields() } })
        .on('GET', '/api/bookings', {
          status: 503,
          body: { error: { code: 'INTERNAL_ERROR', message: 'The database is unreachable.' } },
        });
      api.install();

      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      expect(await screen.findByText('The plan could not be loaded')).toBeInTheDocument();
      expect(screen.getByText('The database is unreachable.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('renders a skeleton of the plan while loading, not a spinner', () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      expect(screen.getByLabelText('Loading the plan')).toBeInTheDocument();
      expect(screen.getByText('Loading the plan…')).toBeInTheDocument();
    });
  });

  describe('cancelled bookings (spec §15)', () => {
    it('marks a cancelled row rather than removing its content', async () => {
      stubPlan({
        bookings: [booking({ offNo: 'X1', status: 'CANCELLED' })],
      });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09');

      const row = await screen.findByRole('row', { name: /Open booking X1/ });
      expect(within(row).getByText('Cancelled')).toBeInTheDocument();
      // The business data is still readable.
      expect(within(row).getByText('Transformer 2B')).toBeInTheDocument();
    });
  });
});
