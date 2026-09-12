import { type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  Booking,
  PlanField,
  SessionResponse,
  UserRole,
} from '@shared/api-types';

/**
 * Frontend test harness.
 *
 * `fetch` is stubbed at the boundary rather than mocking the query hooks, so
 * these tests run through the real API client — including the CSRF header, the
 * error mapping and the retry rules.
 */

export interface RouteStub {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiStub {
  private readonly routes = new Map<string, RouteStub | ((body: unknown) => RouteStub)>();
  readonly calls: Array<{ method: string; url: string; body: unknown; csrf: string | null }> = [];

  on(method: string, pathPattern: string, response: RouteStub | ((body: unknown) => RouteStub)): this {
    this.routes.set(`${method} ${pathPattern}`, response);
    return this;
  }

  install(): void {
    document.cookie = 'committeeflow.csrf=test-csrf-token';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const headers = new Headers(init?.headers);
        this.calls.push({ method, url, body, csrf: headers.get('X-CSRF-Token') });

        const match = [...this.routes.entries()].find(([key]) => {
          const [routeMethod, pattern] = key.split(' ');
          return routeMethod === method && url.startsWith(pattern ?? '');
        });

        const resolved = match
          ? typeof match[1] === 'function'
            ? match[1](body)
            : match[1]
          : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No stub for ' + url } } };

        return new Response(
          resolved.status === 204 ? null : JSON.stringify(resolved.body ?? {}),
          {
            status: resolved.status ?? 200,
            headers: { 'Content-Type': 'application/json', ...(resolved.headers ?? {}) },
          },
        );
      }),
    );
  }
}

export function renderWithProviders(ui: ReactElement, initialRoute = '/plan'): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let fieldCounter = 0;

export function planField(overrides: Partial<PlanField> & Pick<PlanField, 'fieldKey' | 'label'>): PlanField {
  fieldCounter += 1;
  return {
    id: `field-${fieldCounter}`,
    helpText: null,
    fieldType: 'TEXT',
    fieldClass: 'STANDARD',
    storageStrategy: 'COLUMN',
    isRequired: false,
    isVisible: true,
    displayOrder: fieldCounter * 10,
    options: [],
    isActive: true,
    archivedAt: null,
    editability: {
      canRename: true,
      canReorder: true,
      canToggleVisibility: true,
      canToggleRequired: true,
      canEditOptions: false,
      canChangeType: false,
      canArchive: false,
      lockedReason: null,
      populatedBookingCount: 0,
    },
    ...overrides,
  };
}

/** The seeded plan, in its configured order. */
export function defaultPlanFields(): PlanField[] {
  fieldCounter = 0;
  return [
    planField({ fieldKey: 'booking_date', label: 'Date', fieldType: 'DATE', fieldClass: 'SYSTEM', isRequired: true }),
    planField({ fieldKey: 'booking_time', label: 'Time', fieldType: 'TIME', fieldClass: 'SYSTEM', isRequired: true }),
    planField({ fieldKey: 'off_no', label: 'OFF No.', isRequired: true }),
    planField({ fieldKey: 'order_name', label: 'Order Name', isRequired: true }),
    planField({ fieldKey: 'committee', label: 'Committee', isRequired: true }),
    planField({ fieldKey: 'qty', label: 'Qty', fieldType: 'NUMBER' }),
    planField({ fieldKey: 'kva', label: 'KVA', fieldType: 'NUMBER' }),
    planField({ fieldKey: 'kv', label: 'KV', fieldType: 'TEXT' }),
    planField({
      fieldKey: 'status',
      label: 'Status',
      fieldType: 'SELECT',
      options: ['PLANNED', 'CANCELLED'],
    }),
    planField({ fieldKey: 'serial_no', label: 'Serial No.' }),
    planField({ fieldKey: 'project_engineer', label: 'Project Engineer' }),
    planField({ fieldKey: 'notes', label: 'Notes', fieldType: 'LONG_TEXT' }),
    planField({ fieldKey: 'customer_name', label: 'Customer Name' }),
  ];
}

let bookingCounter = 0;

export function booking(overrides: Partial<Booking> = {}): Booking {
  bookingCounter += 1;
  const user = { id: 'user-1', name: 'Ahmed Hassan', email: 'ahmed@committeeflow.test' };
  return {
    id: `booking-${bookingCounter}`,
    bookingDate: '2026-09-09',
    bookingTime: '09:00',
    displayDay: 'Wednesday',
    offNo: `20260100${bookingCounter}`,
    orderName: 'Transformer 2B',
    committee: 'North Committee',
    qty: 3,
    kva: 1500,
    kv: '11/0.4',
    status: 'PLANNED',
    serialNo: '010662606B-020662606B',
    notes: null,
    customerName: 'Aweer Maintenance',
    customFields: {},
    projectEngineer: user,
    cancelledBy: null,
    cancelledAt: null,
    cancellationReason: null,
    deletedBy: null,
    deletedAt: null,
    dataSource: 'MANUAL',
    externalReference: null,
    createdBy: user,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedBy: user,
    updatedAt: '2026-09-01T08:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export function session(role: UserRole, canManagePlanConfiguration = false): SessionResponse {
  return {
    user: {
      id: 'user-1',
      name: role === 'VIEWER' ? 'Sara Viewer' : 'Ahmed Hassan',
      email: 'ahmed@committeeflow.test',
      role,
      canManagePlanConfiguration,
      notifyByEmail: true,
      mustChangePassword: false,
      permissions: {
        canCreateBooking: role === 'PROJECT_ENGINEER',
        canManagePlanConfiguration,
        canExport: true,
      },
    },
    settings: {
      bookingSlotUniqueness: 'NONE',
      bookingEditPolicy: 'ANY_ENGINEER',
      bookingFutureHorizonMonths: 6,
      notificationAudience: 'ALL_ACTIVE_USERS',
    },
    csrfToken: 'test-csrf-token',
  };
}

export function bookingListResponse(bookings: Booking[], from = '2026-09-01', to = '2026-09-30') {
  return {
    bookings,
    facets: {
      committees: [...new Set(bookings.map((b) => b.committee).filter(Boolean))] as string[],
      statuses: [...new Set(bookings.map((b) => b.status).filter(Boolean))] as string[],
      engineers: [{ id: 'user-1', name: 'Ahmed Hassan', email: 'ahmed@committeeflow.test' }],
    },
    range: { from, to },
  };
}
