import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query';
import type {
  ImportBatchListResponse,
  ImportConfirmResponse,
  ImportPreviewResponse,
  ActivityResponse,
  AppSettings,
  Booking,
  BookingHistoryResponse,
  BookingListResponse,
  PlanAccessResponse,
  PlanAccessUser,
  PlanField,
  PlanFieldsResponse,
  PlanFieldValue,
  SessionPreview,
  SessionResponse,
  UpdateAppSettingsRequest,
} from '@shared/api-types';
import { ApiError, api, queryString } from './client';

/**
 * Server state.
 *
 * The plan is shared and changes under you, so reads refetch on window focus
 * and on a slow interval, and every mutation invalidates what it touched
 * (spec §49). No WebSocket — the MVP does not need one.
 */

export const keys = {
  session: ['session'] as const,
  planFields: ['plan-fields'] as const,
  settings: ['settings'] as const,
  bookings: (params: BookingQueryParams) => ['bookings', params] as const,
  booking: (id: string) => ['booking', id] as const,
  bookingHistory: (id: string) => ['booking-history', id] as const,
  sessionPreview: (date: string, time: string, committee: string) =>
    ['session-preview', date, time, committee] as const,
  activity: (page: number, limit: number) => ['activity', page, limit] as const,
  configHistory: (page: number, limit: number) => ['config-history', page, limit] as const,
  imports: ['imports'] as const,
  planAccess: (page: number, limit: number) => ['plan-access', page, limit] as const,
};

/** How often the plan quietly re-checks for other people's changes. */
export const PLAN_REFETCH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => {
      try {
        return await api.get<SessionResponse>('/api/auth/session');
      } catch (error) {
        // Not being signed in is a state, not a failure: it renders the login
        // screen rather than an error.
        if (error instanceof ApiError && error.isUnauthenticated) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { email: string; password: string; rememberMe?: boolean }) =>
      api.post<SessionResponse>('/api/auth/login', credentials),
    onSuccess: (session) => {
      queryClient.setQueryData(keys.session, session);
      void queryClient.invalidateQueries();
    },
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentPassword?: string; newPassword: string }) =>
      api.post<SessionResponse>('/api/auth/change-password', input),
    onSuccess: (session) => {
      queryClient.setQueryData(keys.session, session);
      void queryClient.invalidateQueries();
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSuccess: () => {
      /*
       * Order matters here, and getting it wrong strands the user on a screen
       * they are no longer signed in to.
       *
       * `queryClient.clear()` removes every cache entry — including the one the
       * mounted `useSession` observer is watching. The observer is left holding
       * its last result and attached to nothing, so a `setQueryData` afterwards
       * writes to an entry nobody reads: the server session is gone, but the
       * app keeps rendering the plan until the page is reloaded.
       *
       * So publish the signed-out session *first*, on the entry that is being
       * observed, then cancel anything still in flight and drop the rest.
       */
      queryClient.setQueryData(keys.session, null);
      void queryClient.cancelQueries();
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== keys.session[0],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Plan configuration
// ---------------------------------------------------------------------------

export function usePlanFields() {
  return useQuery({
    queryKey: keys.planFields,
    queryFn: () => api.get<PlanFieldsResponse>('/api/plan-fields'),
    // The configuration changes rarely and drives every other screen.
    staleTime: 5 * 60_000,
    select: (data) => data.fields,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => api.get<AppSettings>('/api/settings'),
    staleTime: 5 * 60_000,
  });
}

function usePlanConfigMutation<TArgs, TResult>(
  mutationFn: (args: TArgs) => Promise<TResult>,
  options?: Omit<UseMutationOptions<TResult, ApiError, TArgs>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, ApiError, TArgs>({
    mutationFn,
    ...options,
    onSuccess: (...args) => {
      // A configuration change reshapes the table, the form and the exports,
      // so everything downstream of it is dropped.
      void queryClient.invalidateQueries({ queryKey: keys.planFields });
      void queryClient.invalidateQueries({ queryKey: ['config-history'] });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      options?.onSuccess?.(...args);
    },
  });
}

export function useCreatePlanField() {
  return usePlanConfigMutation((body: Record<string, unknown>) =>
    api.post<PlanField>('/api/plan-fields', body),
  );
}

export function useUpdatePlanField() {
  return usePlanConfigMutation(({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
    api.patch<PlanField>(`/api/plan-fields/${id}`, patch),
  );
}

export function useArchivePlanField() {
  return usePlanConfigMutation((id: string) => api.post<PlanField>(`/api/plan-fields/${id}/archive`));
}

export function useRestorePlanField() {
  return usePlanConfigMutation((id: string) => api.post<PlanField>(`/api/plan-fields/${id}/restore`));
}

export function useReorderPlanFields() {
  return usePlanConfigMutation((order: string[]) =>
    api.post<PlanFieldsResponse>('/api/plan-fields/reorder', { order }),
  );
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation<AppSettings, ApiError, UpdateAppSettingsRequest>({
    mutationFn: (patch) => api.patch<AppSettings>('/api/settings', patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(keys.settings, settings);
      void queryClient.invalidateQueries({ queryKey: keys.session });
    },
  });
}

/**
 * Who may configure the plan.
 *
 * Only plan managers can read this — the endpoint returns colleagues' email
 * addresses — so it is fetched by the Plan Configuration screen and nowhere
 * else.
 */
export function usePlanAccess(page: number, limit = 25) {
  return useQuery({
    queryKey: keys.planAccess(page, limit),
    queryFn: () => api.get<PlanAccessResponse>(`/api/users?page=${page}&limit=${limit}`),
    placeholderData: (previous) => previous,
  });
}

export function useSetPlanAccess() {
  const queryClient = useQueryClient();
  return useMutation<
    PlanAccessUser,
    ApiError,
    { id: string; canManagePlanConfiguration: boolean }
  >({
    mutationFn: ({ id, canManagePlanConfiguration }) =>
      api.patch<PlanAccessUser>(`/api/users/${id}/plan-access`, { canManagePlanConfiguration }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['plan-access'] });
      void queryClient.invalidateQueries({ queryKey: ['config-history'] });
      // Revoking your own access is refused, but granting it changes what the
      // person doing it sees on their next navigation.
      void queryClient.invalidateQueries({ queryKey: keys.session });
    },
  });
}

export function useConfigurationHistory(enabled: boolean, page: number, limit = 25) {
  return useQuery({
    queryKey: keys.configHistory(page, limit),
    queryFn: () =>
      api.get<{ entries: ConfigurationHistoryEntry[]; page: number; limit: number; total: number; hasMore: boolean }>(
        `/api/plan-fields/history?page=${page}&limit=${limit}`,
      ),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export interface ConfigurationHistoryEntry {
  id: number;
  fieldKey: string;
  action: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'RESTORE' | 'REORDER';
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  changedBy: { id: string; name: string; email: string } | null;
  changedAt: string;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export interface BookingQueryParams {
  month: string;
  search?: string;
  committee?: string;
  status?: string;
  /** A user id: the engineer whose projects to show. */
  projectEngineer?: string;
  includeCancelled?: boolean;
}

export function useBookings(params: BookingQueryParams) {
  return useQuery({
    queryKey: keys.bookings(params),
    queryFn: () =>
      api.get<BookingListResponse>(
        `/api/bookings${queryString({
          month: params.month,
          search: params.search,
          committee: params.committee,
          status: params.status,
          projectEngineer: params.projectEngineer,
          includeCancelled: params.includeCancelled ? 'true' : undefined,
        })}`,
      ),
    // Someone else may be booking right now; keep the plan honest without a
    // socket (spec §49).
    refetchInterval: PLAN_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
  });
}

export function useBooking(id: string | null) {
  return useQuery({
    queryKey: keys.booking(id ?? ''),
    queryFn: () => api.get<Booking>(`/api/bookings/${id}`),
    enabled: Boolean(id),
  });
}

export function useBookingHistory(id: string | null) {
  return useQuery({
    queryKey: keys.bookingHistory(id ?? ''),
    queryFn: () => api.get<BookingHistoryResponse>(`/api/bookings/${id}/history`),
    enabled: Boolean(id),
    select: (data) => data.entries,
  });
}

/**
 * What is already inside the committee session being joined.
 *
 * Informational only: a session that already holds projects still accepts more
 * (CONFIRMED business rule, spec §46/§78.1).
 */
export function useSessionPreview(
  date: string | undefined,
  time: string | undefined,
  committee: string | undefined,
) {
  const ready = Boolean(date && time);
  return useQuery({
    queryKey: keys.sessionPreview(date ?? '', time ?? '', committee ?? ''),
    queryFn: () =>
      api.get<SessionPreview>(
        `/api/bookings/session-preview${queryString({ date, time, committee })}`,
      ),
    enabled: ready,
    staleTime: 15_000,
  });
}

function useBookingMutation<TArgs>(mutationFn: (args: TArgs) => Promise<Booking>) {
  const queryClient = useQueryClient();
  return useMutation<Booking, ApiError, TArgs>({
    mutationFn,
    onSuccess: (booking) => {
      queryClient.setQueryData(keys.booking(booking.id), booking);
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['activity'] });
      void queryClient.invalidateQueries({ queryKey: keys.bookingHistory(booking.id) });
      void queryClient.invalidateQueries({ queryKey: ['session-preview'] });
    },
  });
}

export function useCreateBooking() {
  return useBookingMutation((values: Record<string, PlanFieldValue>) =>
    api.post<Booking>('/api/bookings', { values }),
  );
}

export function useUpdateBooking() {
  return useBookingMutation(
    ({
      id,
      version,
      values,
    }: {
      id: string;
      version: number;
      values: Record<string, PlanFieldValue>;
    }) => api.patch<Booking>(`/api/bookings/${id}`, { version, values }),
  );
}

export function useCancelBooking() {
  return useBookingMutation(
    ({ id, version, reason }: { id: string; version: number; reason?: string }) =>
      api.post<Booking>(`/api/bookings/${id}/cancel`, { version, ...(reason ? { reason } : {}) }),
  );
}

/**
 * Removes a booking that should never have existed.
 *
 * Not a cancellation, and not shaped like one: the server answers 204 because
 * there is no booking left to return, so this cannot reuse `useBookingMutation`
 * — the cached entry is dropped rather than replaced.
 */
export function useDeleteBooking() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, { id: string; version: number }>({
    mutationFn: ({ id, version }) => api.delete<void>(`/api/bookings/${id}`, { version }),
    onSuccess: (_result, { id }) => {
      queryClient.removeQueries({ queryKey: keys.booking(id) });
      queryClient.removeQueries({ queryKey: keys.bookingHistory(id) });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['activity'] });
      void queryClient.invalidateQueries({ queryKey: ['session-preview'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function useActivity(page: number, limit = 50) {
  return useQuery({
    queryKey: keys.activity(page, limit),
    queryFn: () => api.get<ActivityResponse>(`/api/activity${queryString({ page, limit })}`),
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: true,
  });
}

// ---------------------------------------------------------------------------
// Committee Plan import (spec §5, §39)
// ---------------------------------------------------------------------------

/**
 * Preview an upload.
 *
 * Deliberately a mutation rather than a query: it is a POST that carries a file,
 * it must not be retried or refetched on focus, and its result is a step in a
 * workflow rather than cached server state.
 */
export function usePreviewImport() {
  return useMutation<
    ImportPreviewResponse,
    ApiError,
    { file: File; mapping?: Record<string, string | null>; sheet?: string }
  >({
    mutationFn: ({ file, mapping, sheet }) => {
      const form = new FormData();
      form.append('file', file);
      if (mapping) form.append('mapping', JSON.stringify(mapping));
      if (sheet) form.append('sheet', sheet);
      return api.upload<ImportPreviewResponse>('/api/imports/preview', form);
    },
  });
}

/**
 * Commit the confirmed rows.
 *
 * The file is sent again so the server can re-parse and re-validate rather than
 * trust a client-held copy of the preview — the same reason the server does not
 * keep parsed rows between the two requests.
 */
export function useConfirmImport() {
  const queryClient = useQueryClient();
  return useMutation<
    ImportConfirmResponse,
    ApiError,
    { batchId: string; file: File; rowIndexes: number[]; mapping?: Record<string, string | null>; sheet?: string }
  >({
    mutationFn: ({ batchId, file, rowIndexes, mapping, sheet }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('rowIndexes', JSON.stringify(rowIndexes));
      if (mapping) form.append('mapping', JSON.stringify(mapping));
      if (sheet) form.append('sheet', sheet);
      return api.upload<ImportConfirmResponse>(`/api/imports/${batchId}/confirm`, form);
    },
    onSuccess: () => {
      // An import can add bookings to any month, so nothing about the plan or
      // the audit trail can be assumed still current.
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['activity'] });
      void queryClient.invalidateQueries({ queryKey: keys.imports });
    },
  });
}

export function useImportHistory(page = 1, limit = 20, enabled = true) {
  return useQuery({
    queryKey: [...keys.imports, page, limit],
    queryFn: () =>
      api.get<ImportBatchListResponse>(`/api/imports${queryString({ page, limit })}`),
    enabled,
  });
}
