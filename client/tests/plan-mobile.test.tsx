import { beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPage } from '@/features/plan/PlanPage';
import { AppShell } from '@/components/AppShell';
import { groupFieldsIntoSections } from '@/features/bookings/sections';
import {
  ApiStub,
  booking,
  bookingListResponse,
  defaultPlanFields,
  planField,
  renderWithProviders,
  session,
} from './harness';
import { setViewportWidth } from './setup';

const PHONE = 375;
const TABLET = 900;

/**
 * The Committee Plan at phone and tablet width.
 *
 * The layout is chosen in JavaScript, so "which layout am I looking at" is a
 * behaviour with a right answer, not a styling detail — these assert it. The
 * desktop suite in `plan.test.tsx` runs at the default 1280px and is unchanged.
 */
describe('Committee Plan on a phone', () => {
  let api: ApiStub;

  beforeEach(() => {
    api = new ApiStub();
    setViewportWidth(PHONE);
  });

  /** One session with three projects, plus a second session the same day. */
  function stubPlan(options: { role?: 'PROJECT_ENGINEER' | 'VIEWER'; canManage?: boolean } = {}) {
    const bookings = [
      booking({ offNo: 'A1', orderName: 'Transformer 2B', bookingTime: '10:00', committee: 'South Committee' }),
      booking({ offNo: 'A2', orderName: 'HV Cable Box', bookingTime: '10:00', committee: 'South Committee' }),
      booking({ offNo: 'A3', orderName: 'Package Substation', bookingTime: '10:00', committee: 'South Committee' }),
      booking({ offNo: 'B1', orderName: 'Feeder Pillar', bookingTime: '13:00', committee: 'EPOWER Committee' }),
    ];

    api
      .on('GET', '/api/auth/session', {
        body: session(options.role ?? 'PROJECT_ENGINEER', options.canManage ?? false),
      })
      .on('GET', '/api/plan-fields', { body: { fields: defaultPlanFields() } })
      .on('GET', '/api/settings', { body: session('VIEWER').settings })
      .on('GET', '/api/bookings/session-preview', {
        body: {
          bookingDate: '2026-09-09',
          bookingTime: '10:00',
          committee: 'South Committee',
          count: 3,
          bookings: bookings.slice(0, 3).map((b) => ({
            id: b.id,
            offNo: b.offNo,
            orderName: b.orderName,
            customerName: b.customerName,
            status: b.status,
            createdBy: b.createdBy,
          })),
        },
      })
      .on('GET', '/api/bookings', { body: bookingListResponse(bookings) });
    api.install();
    return bookings;
  }

  describe('layout', () => {
    it('replaces the column table with the session agenda', async () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');

      // The table's column headings are the thing that cannot survive 375px.
      expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /WEDNESDAY · 09 SEP/i })).toBeInTheDocument();
    });

    it('keeps the desktop table once there is width for its columns', async () => {
      setViewportWidth(1280);
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
    });

    it('uses the agenda on a tablet, which is still too narrow for the table', async () => {
      setViewportWidth(TABLET);
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
    });

    /*
     * A tablet gets rotated and a desktop window gets dragged narrower. The
     * layout has to follow without a reload — and this is the one behaviour the
     * browser preview could not be used to check, because it changes the
     * viewport through the debugging protocol, which dispatches neither
     * `resize` nor a media-query `change`.
     */
    it('switches layout when the viewport changes, without reloading', async () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();

      act(() => setViewportWidth(1280));
      await waitFor(() => {
        expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
      });

      act(() => setViewportWidth(PHONE));
      await waitFor(() => {
        expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
      });
      // Still the same month, still the same data — only the presentation moved.
      expect(screen.getByText('Transformer 2B')).toBeInTheDocument();
    });
  });

  describe('shared committee sessions (spec §46, §78.1 — confirmed)', () => {
    it('states how many projects a session already holds', async () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');

      // The headline fact of the mobile plan: this committee is coming, and it
      // already carries this much work.
      const sessionHead = screen.getByRole('button', {
        name: /View the South Committee session at 10:00/i,
      });
      expect(within(sessionHead).getByText('3 projects')).toBeInTheDocument();
      expect(
        within(
          screen.getByRole('button', { name: /View the EPOWER Committee session at 13:00/i }),
        ).getByText('1 project'),
      ).toBeInTheDocument();
    });

    it('opens a session showing every project in it', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      await user.click(
        screen.getByRole('button', { name: /View the South Committee session at 10:00/i }),
      );

      const dialog = await screen.findByRole('dialog');
      // The count is emphasised inside the sentence, so match the rendered text.
      expect(dialog.textContent).toContain('3 projects');
      expect(dialog.textContent).toContain('in this session');
      expect(within(dialog).getByText('Transformer 2B')).toBeInTheDocument();
      expect(within(dialog).getByText('HV Cable Box')).toBeInTheDocument();
      expect(within(dialog).getByText('Package Substation')).toBeInTheDocument();
    });

    it('prefills the schedule when adding a project to an existing session', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      await user.click(
        screen.getByRole('button', { name: /View the South Committee session at 10:00/i }),
      );
      await user.click(await screen.findByRole('button', { name: 'Add project' }));

      await screen.findByText('Book Committee Slot');
      expect(screen.getByLabelText(/^Date/)).toHaveValue('2026-09-09');
      expect(screen.getByLabelText(/^Time/)).toHaveValue('10:00');
      expect(screen.getByLabelText(/^Committee/)).toHaveValue('South Committee');
    });

    it('presents an occupied session as context, never as a conflict', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      await user.click(
        screen.getByRole('button', { name: /View the South Committee session at 10:00/i }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Adding another project to this session is normal/i)).toBeInTheDocument();
      expect(within(dialog).queryByText(/conflict/i)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/already booked/i)).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Add project' })).toBeEnabled();
    });
  });

  describe('role (spec §4, §41)', () => {
    it('gives a Project Engineer the booking action', async () => {
      stubPlan();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      expect(screen.getByRole('button', { name: /^Book$/ })).toBeInTheDocument();
    });

    it('shows a Viewer no booking action at all, disabled or otherwise', async () => {
      stubPlan({ role: 'VIEWER' });
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      expect(screen.queryByRole('button', { name: /^Book$/ })).not.toBeInTheDocument();

      await user.click(
        screen.getByRole('button', { name: /View the South Committee session at 10:00/i }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('button', { name: 'Add project' })).not.toBeInTheDocument();
    });
  });

  describe('filters (spec §6)', () => {
    it('applies filters from the sheet and shows them as removable chips', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      await user.click(screen.getByRole('button', { name: /^Filters/i }));

      const sheet = await screen.findByRole('dialog');
      await user.selectOptions(within(sheet).getByLabelText('Committee'), 'South Committee');
      await user.click(within(sheet).getByRole('button', { name: 'Show results' }));

      await waitFor(() => {
        expect(
          api.calls.some((call) => call.url.includes('committee=South+Committee')),
        ).toBe(true);
      });

      // A filter hidden behind a sheet must still be visible on the plan.
      const chip = await screen.findByRole('button', { name: /South Committee.*Remove this filter/s });
      await user.click(chip);
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /South Committee.*Remove this filter/s })).not.toBeInTheDocument();
      });
    });
  });

  describe('navigation', () => {
    function shell(canManage: boolean) {
      return renderWithProviders(
        <AppShell
          session={session('PROJECT_ENGINEER', canManage)}
          theme="light"
          onToggleTheme={() => undefined}
          onChangePassword={() => undefined}
        >
          <div />
        </AppShell>,
        '/plan',
      );
    }

    it('offers Plan, Activity and Config to someone who can configure the plan', () => {
      api.on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER', true) });
      api.install();
      shell(true);

      const nav = screen.getByRole('navigation', { name: 'Sections' });
      expect(within(nav).getByRole('link', { name: /Plan/ })).toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: /Activity/ })).toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: /Config/ })).toBeInTheDocument();
    });

    it('omits Config entirely rather than disabling it', () => {
      api.on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER', false) });
      api.install();
      shell(false);

      const nav = screen.getByRole('navigation', { name: 'Sections' });
      expect(within(nav).queryByRole('link', { name: /Config/ })).not.toBeInTheDocument();
      expect(within(nav).queryByText(/Config/)).not.toBeInTheDocument();
    });

    it('keeps the theme switch outside the account menu', async () => {
      api.on('GET', '/api/auth/session', { body: session('PROJECT_ENGINEER', true) });
      api.install();
      const user = userEvent.setup();
      shell(true);

      expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: /^Account:/ }));

      const menu = screen.getByRole('menu');
      expect(within(menu).queryByRole('menuitem', { name: /mode/i })).not.toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: 'Change password' })).toBeVisible();
    });
  });
});

/**
 * The mobile form's sections are a presentation of the configuration, not a
 * second schema — so they have to keep following it.
 */
describe('Booking form sections', () => {
  it('places each configured field in a section and keeps the configured order', () => {
    const sections = groupFieldsIntoSections(defaultPlanFields());

    expect(sections.map((s) => s.title)).toEqual([
      'Schedule',
      'Project',
      'Technical',
      'Additional details',
    ]);
    expect(sections[0]?.fields.map((f) => f.fieldKey)).toEqual([
      'booking_date',
      'booking_time',
      'committee',
    ]);
    expect(sections[2]?.fields.map((f) => f.fieldKey)).toEqual(['qty', 'kva', 'kv', 'serial_no']);
  });

  it('puts a custom field in Additional details without being told about it', () => {
    const fields = [
      ...defaultPlanFields(),
      planField({ fieldKey: 'inspection_body', label: 'Inspection Body', fieldClass: 'CUSTOM' }),
    ];

    const additional = groupFieldsIntoSections(fields).find((s) => s.id === 'additional');
    expect(additional?.fields.map((f) => f.fieldKey)).toContain('inspection_body');
  });

  it('follows a rename, because it groups on the permanent key (spec §20)', () => {
    const renamed = defaultPlanFields().map((field) =>
      field.fieldKey === 'customer_name' ? { ...field, label: 'Client' } : field,
    );

    const project = groupFieldsIntoSections(renamed).find((s) => s.id === 'project');
    expect(project?.fields.map((f) => f.label)).toContain('Client');
  });

  it('drops a section whose fields are all hidden rather than showing an empty heading', () => {
    const withoutTechnical = defaultPlanFields().filter(
      (field) => !['qty', 'kva', 'kv', 'serial_no'].includes(field.fieldKey),
    );

    expect(groupFieldsIntoSections(withoutTechnical).map((s) => s.id)).not.toContain('technical');
  });
});
