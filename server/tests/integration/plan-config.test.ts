import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { PlanField } from '@shared/api-types.js';
import { query } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import {
  Session,
  bookingPayload,
  createBookingVia,
  resetDatabase,
  signIn,
} from '../helpers/harness.js';

/** Spec §5, §19–§25, §34, §35, §77 — the configurable plan. */
describe('plan configuration', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  async function planManager() {
    return signIn({ role: 'PROJECT_ENGINEER', canManagePlanConfiguration: true });
  }

  async function fieldByKey(session: Session, key: string): Promise<PlanField> {
    const res = await session.get('/api/plan-fields');
    const field = (res.body.fields as PlanField[]).find((f) => f.fieldKey === key);
    if (!field) throw new Error(`no plan field ${key}`);
    return field;
  }

  describe('permission (spec §5)', () => {
    it('lets every signed-in user read the configuration', async () => {
      const { session: viewer } = await signIn({ role: 'VIEWER' });
      const res = await viewer.get('/api/plan-fields');
      expect(res.status).toBe(200);
      expect(res.body.fields).toHaveLength(13);
    });

    it('refuses writes without the restricted permission, whatever the role', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: viewer } = await signIn({ role: 'VIEWER' });
      const { session: manager } = await planManager();
      const field = await fieldByKey(manager, 'status');

      for (const [label, session] of [
        ['engineer', engineer],
        ['viewer', viewer],
      ] as const) {
        expect(
          (await session.post('/api/plan-fields', {
            fieldKey: 'factory',
            label: 'Factory',
            fieldType: 'TEXT',
          })).status,
          label,
        ).toBe(403);
        expect((await session.patch(`/api/plan-fields/${field.id}`, { label: 'X' })).status, label).toBe(403);
        expect((await session.post(`/api/plan-fields/${field.id}/archive`)).status, label).toBe(403);
        expect((await session.post('/api/plan-fields/reorder', { order: [field.id] })).status, label).toBe(403);
      }
    });

    it('grants the permission independently of the role', async () => {
      // A Viewer with the permission may configure the plan but still not book.
      const { session } = await signIn({ role: 'VIEWER', canManagePlanConfiguration: true });

      expect(
        (await session.post('/api/plan-fields', {
          fieldKey: 'factory',
          label: 'Factory',
          fieldType: 'TEXT',
        })).status,
      ).toBe(201);
      expect((await session.post('/api/bookings', bookingPayload())).status).toBe(403);
    });
  });

  describe('renaming (spec §20)', () => {
    it('changes the label while the technical key stays put', async () => {
      const { session } = await planManager();
      const before = await fieldByKey(session, 'customer_name');

      const res = await session.patch(`/api/plan-fields/${before.id}`, { label: 'Client Name' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ fieldKey: 'customer_name', label: 'Client Name' });
    });

    it('offers no way to change a technical key', async () => {
      const { session } = await planManager();
      const field = await fieldByKey(session, 'customer_name');

      // fieldKey is not part of the update schema; sending it changes nothing.
      const res = await session.patch(`/api/plan-fields/${field.id}`, {
        label: 'Client Name',
        fieldKey: 'client_name',
      });

      expect(res.body.fieldKey).toBe('customer_name');
      const stored = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM plan_field_definitions WHERE field_key = 'client_name'",
      );
      expect(stored.rows[0]?.n).toBe(0);
    });

    it('rejects a blank label', async () => {
      const { session } = await planManager();
      const field = await fieldByKey(session, 'status');
      expect((await session.patch(`/api/plan-fields/${field.id}`, { label: '   ' })).status).toBe(422);
    });
  });

  describe('visibility, requiredness and order (spec §19, §21)', () => {
    it('hides a standard field from the plan', async () => {
      const { session } = await planManager();
      const kva = await fieldByKey(session, 'kva');

      const res = await session.patch(`/api/plan-fields/${kva.id}`, { isVisible: false });

      expect(res.status).toBe(200);
      expect(res.body.isVisible).toBe(false);
    });

    it('refuses to hide a system field', async () => {
      const { session } = await planManager();
      const date = await fieldByKey(session, 'booking_date');

      const res = await session.patch(`/api/plan-fields/${date.id}`, { isVisible: false });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/must stay visible/i);
    });

    it('makes a field required and enforces it on the very next booking', async () => {
      const { session } = await planManager();
      const customer = await fieldByKey(session, 'customer_name');

      expect((await session.post('/api/bookings', bookingPayload())).status).toBe(201);

      await session.patch(`/api/plan-fields/${customer.id}`, { isRequired: true });

      const res = await session.post('/api/bookings', bookingPayload({ off_no: 'B' }));
      expect(res.status).toBe(422);
      expect(res.body.error.issues[0]).toMatchObject({ field: 'customer_name' });
    });

    it('makes a field optional again', async () => {
      const { session } = await planManager();
      const offNo = await fieldByKey(session, 'off_no');

      await session.patch(`/api/plan-fields/${offNo.id}`, { isRequired: false });

      const res = await session.post('/api/bookings', {
        values: {
          booking_date: '2026-10-06',
          booking_time: '10:00',
          order_name: 'No OFF number yet',
          committee: 'North',
        },
      });
      expect(res.status).toBe(201);
    });

    it('reorders fields and keeps unlisted ones on the plan', async () => {
      const { session } = await planManager();
      const all = (await session.get('/api/plan-fields')).body.fields as PlanField[];
      const committee = all.find((f) => f.fieldKey === 'committee')!;
      const date = all.find((f) => f.fieldKey === 'booking_date')!;

      const res = await session.post('/api/plan-fields/reorder', {
        order: [committee.id, date.id],
      });

      expect(res.status).toBe(200);
      const reordered = res.body.fields as PlanField[];
      expect(reordered[0]?.fieldKey).toBe('committee');
      expect(reordered[1]?.fieldKey).toBe('booking_date');
      // Nothing was dropped.
      expect(reordered).toHaveLength(13);
    });

    it('rejects a reorder that names an unknown field', async () => {
      const { session } = await planManager();
      const res = await session.post('/api/plan-fields/reorder', {
        order: ['00000000-0000-4000-8000-000000000000'],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('custom fields (spec §21, §22, §30)', () => {
    it('adds a custom field and stores its value in JSONB, not a new column', async () => {
      const { session } = await planManager();

      const created = await session.post('/api/plan-fields', {
        fieldKey: 'project_manager',
        label: 'Project Manager',
        fieldType: 'TEXT',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        fieldClass: 'CUSTOM',
        storageStrategy: 'CUSTOM_JSONB',
      });

      const booking = await createBookingVia(session, { project_manager: 'Mohamed Ali' });
      expect(booking.customFields['project_manager']).toBe('Mohamed Ali');

      const columns = await query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings'",
      );
      expect(columns.rows.map((r) => r.column_name)).not.toContain('project_manager');
    });

    it('supports the documented field types and nothing more', async () => {
      const { session } = await planManager();
      const types = ['TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'TIME', 'CHECKBOX'];

      for (const [index, fieldType] of types.entries()) {
        const res = await session.post('/api/plan-fields', {
          fieldKey: `custom_${index}`,
          label: `Custom ${index}`,
          fieldType,
        });
        expect(res.status, fieldType).toBe(201);
      }

      const formula = await session.post('/api/plan-fields', {
        fieldKey: 'computed_total',
        label: 'Computed',
        fieldType: 'FORMULA',
      });
      expect(formula.status).toBe(422);
    });

    it('validates a SELECT field against its options', async () => {
      const { session } = await planManager();
      await session.post('/api/plan-fields', {
        fieldKey: 'inspection_type',
        label: 'Inspection Type',
        fieldType: 'SELECT',
        options: ['Routine', 'Witness', 'Final'],
      });

      expect((await session.post('/api/bookings', bookingPayload({ inspection_type: 'Witness' }))).status).toBe(201);

      const bad = await session.post(
        '/api/bookings',
        bookingPayload({ off_no: 'B', inspection_type: 'Nonsense' }),
      );
      expect(bad.status).toBe(422);
      expect(bad.body.error.issues[0].message).toMatch(/Routine, Witness, Final/);
    });

    it('requires at least one option for a SELECT field', async () => {
      const { session } = await planManager();
      const res = await session.post('/api/plan-fields', {
        fieldKey: 'empty_select',
        label: 'Empty',
        fieldType: 'SELECT',
        options: [],
      });
      expect(res.status).toBe(422);
    });

    it('coerces and validates a CHECKBOX and a NUMBER custom field', async () => {
      const { session } = await planManager();
      await session.post('/api/plan-fields', {
        fieldKey: 'witnessed',
        label: 'Witnessed',
        fieldType: 'CHECKBOX',
      });
      await session.post('/api/plan-fields', {
        fieldKey: 'line_number',
        label: 'Line',
        fieldType: 'NUMBER',
      });

      const booking = await createBookingVia(session, { witnessed: true, line_number: 4 });
      expect(booking.customFields['witnessed']).toBe(true);
      expect(booking.customFields['line_number']).toBe(4);

      const bad = await session.post(
        '/api/bookings',
        bookingPayload({ off_no: 'B', line_number: 'not a number' }),
      );
      expect(bad.status).toBe(422);
    });

    it('refuses a key that collides with a system or reserved name', async () => {
      const { session } = await planManager();

      for (const fieldKey of ['off_no', 'booking_date', 'version', 'created_by', 'custom_fields']) {
        const res = await session.post('/api/plan-fields', {
          fieldKey,
          label: 'Nope',
          fieldType: 'TEXT',
        });
        expect(res.status, fieldKey).toBe(422);
      }
    });

    it('refuses a malformed key and a duplicate key', async () => {
      const { session } = await planManager();

      expect(
        (await session.post('/api/plan-fields', { fieldKey: 'Bad Key!', label: 'X', fieldType: 'TEXT' }))
          .status,
      ).toBe(422);

      await session.post('/api/plan-fields', { fieldKey: 'factory', label: 'Factory', fieldType: 'TEXT' });
      const duplicate = await session.post('/api/plan-fields', {
        fieldKey: 'factory',
        label: 'Factory Again',
        fieldType: 'TEXT',
      });
      expect(duplicate.status).toBe(409);
    });
  });

  describe('archiving (spec §23)', () => {
    it('archives a custom field, removes it from new forms, keeps old values', async () => {
      const { session } = await planManager();
      const created = await session.post('/api/plan-fields', {
        fieldKey: 'factory',
        label: 'Factory',
        fieldType: 'TEXT',
      });
      const booking = await createBookingVia(session, { factory: 'Plant 3' });

      const archived = await session.post(`/api/plan-fields/${created.body.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ isActive: false });
      expect(archived.body.archivedAt).toBeTruthy();

      // Historical value survives.
      const stored = await session.get(`/api/bookings/${booking.id}`);
      expect(stored.body.customFields['factory']).toBe('Plant 3');

      // New bookings no longer accept it.
      const rejected = await session.post('/api/bookings', bookingPayload({ off_no: 'B', factory: 'Plant 4' }));
      expect(rejected.status).toBe(422);

      // The row itself was never deleted.
      const rows = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM plan_field_definitions WHERE field_key = 'factory'",
      );
      expect(rows.rows[0]?.n).toBe(1);
    });

    it('restores an archived field', async () => {
      const { session } = await planManager();
      const created = await session.post('/api/plan-fields', {
        fieldKey: 'factory',
        label: 'Factory',
        fieldType: 'TEXT',
      });
      await session.post(`/api/plan-fields/${created.body.id}/archive`);

      const restored = await session.post(`/api/plan-fields/${created.body.id}/restore`);

      expect(restored.status).toBe(200);
      expect(restored.body.isActive).toBe(true);
      expect((await session.post('/api/bookings', bookingPayload({ factory: 'Plant 4' }))).status).toBe(201);
    });

    it('refuses to archive a standard or system field', async () => {
      const { session } = await planManager();
      const status = await fieldByKey(session, 'status');
      const date = await fieldByKey(session, 'booking_date');

      expect((await session.post(`/api/plan-fields/${status.id}/archive`)).status).toBe(400);
      expect((await session.post(`/api/plan-fields/${date.id}/archive`)).status).toBe(400);
    });
  });

  describe('type locking (spec §20, §24)', () => {
    it('lets a text-backed standard field become a Select list', async () => {
      const { session } = await planManager();
      const customerName = await fieldByKey(session, 'customer_name');

      const res = await session.patch(`/api/plan-fields/${customerName.id}`, {
        fieldType: 'SELECT',
        options: ['DEWA', 'ADNOC Onshore', 'Emirates Steel'],
      });

      expect(res.status).toBe(200);
      expect(res.body.fieldType).toBe('SELECT');
      expect(
        (await session.post('/api/bookings', bookingPayload({ customer_name: 'DEWA' }))).status,
      ).toBe(201);
      expect(
        (await session.post('/api/bookings', bookingPayload({ off_no: 'B', customer_name: 'Someone else' })))
          .status,
      ).toBe(422);
    });

    /*
     * Status used to be this test's example, and that is the point. It was an
     * ordinary text field a plan manager could reshape at will — which is how a
     * column meant for a booking's lifecycle came to hold `010662606B`. It
     * drives cancellation now, so its type and its two values belong to the
     * application.
     */
    it('refuses to reshape Status, whatever is asked of it', async () => {
      const { session } = await planManager();
      const status = await fieldByKey(session, 'status');

      expect(status.editability.canChangeType).toBe(false);
      expect(status.editability.canEditOptions).toBe(false);
      expect(status.editability.canArchive).toBe(false);
      expect(status.editability.canToggleRequired).toBe(false);

      // Back to free text, where a serial number would fit again.
      const retyped = await session.patch(`/api/plan-fields/${status.id}`, { fieldType: 'TEXT' });
      expect(retyped.status).toBeGreaterThanOrEqual(400);

      // Or a third state the application would not know what to do with.
      const extraOption = await session.patch(`/api/plan-fields/${status.id}`, {
        options: ['PLANNED', 'CANCELLED', 'POSTPONED'],
      });
      expect(extraOption.status).toBeGreaterThanOrEqual(400);

      const after = await fieldByKey(session, 'status');
      expect(after.fieldType).toBe('SELECT');
      expect(after.options).toEqual(['PLANNED', 'CANCELLED']);
    });

    it('keeps Project Engineer a reference to a user', async () => {
      const { session } = await planManager();
      const engineer = await fieldByKey(session, 'project_engineer');

      // Its column is a foreign key; as free text it would be a name that stops
      // meaning anything the moment somebody is renamed.
      expect(engineer.editability.canChangeType).toBe(false);
      expect(engineer.editability.canToggleRequired).toBe(false);
      // It is already TEXT, so asking for TEXT changes nothing; the refusal that
      // matters is any attempt to make it something else.
      const retyped = await session.patch(`/api/plan-fields/${engineer.id}`, {
        fieldType: 'SELECT',
        options: ['Ahmed Hassan', 'Karim Ayman'],
      });
      expect(retyped.status).toBeGreaterThanOrEqual(400);

      // Presentation stays a plan manager's business.
      expect(engineer.editability.canRename).toBe(true);
      expect(engineer.editability.canReorder).toBe(true);
      expect(engineer.editability.canToggleVisibility).toBe(true);
    });

    it('refuses a type its column cannot hold', async () => {
      const { session } = await planManager();
      const qty = await fieldByKey(session, 'qty');

      const res = await session.patch(`/api/plan-fields/${qty.id}`, { fieldType: 'TEXT' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/fixed column/i);
    });

    it('locks a populated custom field to its type', async () => {
      const { session } = await planManager();
      const created = await session.post('/api/plan-fields', {
        fieldKey: 'line_number',
        label: 'Line',
        fieldType: 'NUMBER',
      });
      await createBookingVia(session, { line_number: 3 });

      const res = await session.patch(`/api/plan-fields/${created.body.id}`, { fieldType: 'TEXT' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already holds data/i);
    });

    it('allows TEXT to SELECT only when every stored value is an option', async () => {
      const { session } = await planManager();
      const created = await session.post('/api/plan-fields', {
        fieldKey: 'shift',
        label: 'Shift',
        fieldType: 'TEXT',
      });
      await createBookingVia(session, { off_no: 'A', shift: 'Morning' });
      await createBookingVia(session, { off_no: 'B', booking_time: '14:00', shift: 'Night' });

      const missing = await session.patch(`/api/plan-fields/${created.body.id}`, {
        fieldType: 'SELECT',
        options: ['Morning'],
      });
      expect(missing.status).toBe(409);
      expect(missing.body.error.message).toMatch(/"Night"/);

      const complete = await session.patch(`/api/plan-fields/${created.body.id}`, {
        fieldType: 'SELECT',
        options: ['Morning', 'Night'],
      });
      expect(complete.status).toBe(200);
    });

    it('refuses to remove a Select option that bookings still use', async () => {
      const { session } = await planManager();
      const created = await session.post('/api/plan-fields', {
        fieldKey: 'inspection_type',
        label: 'Inspection Type',
        fieldType: 'SELECT',
        options: ['Routine', 'Witness'],
      });
      await createBookingVia(session, { inspection_type: 'Witness' });

      const res = await session.patch(`/api/plan-fields/${created.body.id}`, {
        options: ['Routine'],
      });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/still use/i);
    });

    it('reports editability so the UI can explain what is locked', async () => {
      const { session } = await planManager();
      await createBookingVia(session, { qty: 3 });

      const fields = (await session.get('/api/plan-fields')).body.fields as PlanField[];
      const date = fields.find((f) => f.fieldKey === 'booking_date')!;
      const qty = fields.find((f) => f.fieldKey === 'qty')!;
      const notes = fields.find((f) => f.fieldKey === 'notes')!;

      expect(date.editability).toMatchObject({
        canRename: true,
        canToggleVisibility: false,
        canArchive: false,
      });
      expect(date.editability.lockedReason).toMatch(/required by the application/i);

      expect(qty.editability.populatedBookingCount).toBe(1);
      expect(qty.editability.canChangeType).toBe(false);

      expect(notes.editability.populatedBookingCount).toBe(0);
    });
  });

  describe('configuration audit (spec §25)', () => {
    it('records every configuration change with its author', async () => {
      const { session, user } = await planManager();
      const status = await fieldByKey(session, 'status');

      await session.patch(`/api/plan-fields/${status.id}`, { label: 'Progress' });
      const created = await session.post('/api/plan-fields', {
        fieldKey: 'factory',
        label: 'Factory',
        fieldType: 'TEXT',
      });
      await session.post(`/api/plan-fields/${created.body.id}/archive`);

      const res = await session.get('/api/plan-fields/history');

      expect(res.status).toBe(200);
      const actions = res.body.entries.map((e: { action: string }) => e.action);
      expect(actions).toEqual(['ARCHIVE', 'CREATE', 'UPDATE']);
      expect(res.body.entries[2].oldValue.label).toBe('Status');
      expect(res.body.entries[2].newValue.label).toBe('Progress');
      expect(res.body.entries[0].changedBy.id).toBe(user.id);
    });

    it('keeps the configuration history behind the same permission', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      expect((await session.get('/api/plan-fields/history')).status).toBe(403);
    });
  });

  describe('one configuration drives everything (spec §35, §77)', () => {
    it('a rename reaches the plan API, details and the Excel export together', async () => {
      const { session } = await planManager();
      const customer = await fieldByKey(session, 'customer_name');
      await createBookingVia(session, { customer_name: 'Aweer' });

      await session.patch(`/api/plan-fields/${customer.id}`, { label: 'Client Name' });

      const fields = (await session.get('/api/plan-fields')).body.fields as PlanField[];
      expect(fields.find((f) => f.fieldKey === 'customer_name')?.label).toBe('Client Name');

      const excel = await session.getBinary('/api/export/excel?month=2026-10');
      expect(excel.status).toBe(200);
      expect(Buffer.isBuffer(excel.body)).toBe(true);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(excel.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const headers = (workbook.getWorksheet('Committee Plan')!.getRow(3).values as unknown[]).slice(1);
      expect(headers).toContain('Client Name');
      expect(headers).not.toContain('Customer Name');
    });
  });

  describe('settings (the business rules from spec §78)', () => {
    it('is readable by everyone and writable only by a plan manager', async () => {
      const { session: viewer } = await signIn({ role: 'VIEWER' });
      const read = await viewer.get('/api/settings');
      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        bookingSlotUniqueness: 'NONE',
        bookingEditPolicy: 'ANY_ENGINEER',
        bookingFutureHorizonMonths: 6,
        notificationAudience: 'ALL_ACTIVE_USERS',
      });

      expect((await viewer.patch('/api/settings', { bookingSlotUniqueness: 'DATE' })).status).toBe(403);

      const { session: manager } = await planManager();
      const written = await manager.patch('/api/settings', { bookingSlotUniqueness: 'DATE_TIME' });
      expect(written.status).toBe(200);
      expect(written.body.bookingSlotUniqueness).toBe('DATE_TIME');
    });

    it('rejects a value outside the documented set', async () => {
      const { session } = await planManager();
      expect((await session.patch('/api/settings', { bookingSlotUniqueness: 'WHATEVER' })).status).toBe(422);
      expect((await session.patch('/api/settings', { bookingEditPolicy: 'EVERYONE' })).status).toBe(422);
      expect((await session.patch('/api/settings', { bookingFutureHorizonMonths: 0 })).status).toBe(422);
    });
  });
});
