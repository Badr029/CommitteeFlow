/**
 * The CommitteeFlow HTTP contract.
 *
 * Type-only. Both `server/` and `client/` compile against this file, so a
 * response shape cannot change on one side without breaking the other's build.
 * It must never contain runtime values — only `type` and `interface` — because
 * both sides import it with `import type`.
 */

// ---------------------------------------------------------------------------
// Identity and access (spec §4, §5, §31)
// ---------------------------------------------------------------------------

export type UserRole = 'PROJECT_ENGINEER' | 'VIEWER';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  canManagePlanConfiguration: boolean;
  notifyByEmail: boolean;
  /** A temporary script-issued password must be replaced before app access. */
  mustChangePassword: boolean;
  /** Everything this session is allowed to do, resolved on the server. */
  permissions: UserPermissions;
}

/**
 * Server-resolved capabilities.
 *
 * The client uses these purely to decide what to render. The backend enforces
 * the same rules independently on every request (spec §41) — this object is UX,
 * never security.
 */
export interface UserPermissions {
  canCreateBooking: boolean;
  canManagePlanConfiguration: boolean;
  canExport: boolean;
}

/** Author/actor reference embedded in bookings and history entries. */
export interface UserRef {
  id: string;
  name: string;
  email: string;
}

/**
 * An account as the Plan Configuration screen sees it.
 *
 * Only what that screen needs to decide who may configure the plan. It is not a
 * general user record: the MVP has no user administration (spec §7).
 */
export interface PlanAccessUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  canManagePlanConfiguration: boolean;
}

export interface PlanAccessResponse {
  users: PlanAccessUser[];
  page: number;
  limit: number;
  total: number;
  managerCount: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Plan configuration (spec §21, §22, §34)
// ---------------------------------------------------------------------------

export type PlanFieldType =
  | 'TEXT'
  | 'LONG_TEXT'
  | 'NUMBER'
  | 'SELECT'
  | 'DATE'
  | 'TIME'
  | 'CHECKBOX';

export type PlanFieldClass = 'SYSTEM' | 'STANDARD' | 'CUSTOM';

export type PlanFieldStorage = 'COLUMN' | 'CUSTOM_JSONB';

export interface PlanField {
  id: string;
  /** Stable technical key. Never changes once the field exists (spec §20). */
  fieldKey: string;
  /** User-facing label. Freely configurable. */
  label: string;
  helpText: string | null;
  fieldType: PlanFieldType;
  fieldClass: PlanFieldClass;
  storageStrategy: PlanFieldStorage;
  isRequired: boolean;
  isVisible: boolean;
  displayOrder: number;
  /** Allowed values for SELECT fields; empty for every other type. */
  options: string[];
  isActive: boolean;
  archivedAt: string | null;
  /**
   * What a plan manager is allowed to change right now, computed server-side
   * from the field's class and whether bookings already hold data for it
   * (spec §24).
   */
  editability: PlanFieldEditability;
}

export interface PlanFieldEditability {
  canRename: boolean;
  canReorder: boolean;
  canToggleVisibility: boolean;
  canToggleRequired: boolean;
  canEditOptions: boolean;
  canChangeType: boolean;
  canArchive: boolean;
  /** Human-readable reason when something above is false. */
  lockedReason: string | null;
  /** How many bookings currently hold a non-empty value for this field. */
  populatedBookingCount: number;
}

export interface PlanFieldsResponse {
  fields: PlanField[];
}

export interface CreatePlanFieldRequest {
  fieldKey: string;
  label: string;
  fieldType: PlanFieldType;
  helpText?: string | null;
  isRequired?: boolean;
  isVisible?: boolean;
  options?: string[];
  displayOrder?: number;
}

export interface UpdatePlanFieldRequest {
  label?: string;
  helpText?: string | null;
  isRequired?: boolean;
  isVisible?: boolean;
  options?: string[];
  displayOrder?: number;
  fieldType?: PlanFieldType;
}

export interface ReorderPlanFieldsRequest {
  /** Field ids in their new top-to-bottom order. */
  order: string[];
}

// ---------------------------------------------------------------------------
// Bookings (spec §32)
// ---------------------------------------------------------------------------

/**
 * A booking's lifecycle, and the whole of it.
 *
 * There used to be two: a `booking_state` of ACTIVE/CANCELLED that drove
 * cancellation, and a free-text `status` a user could type anything into — which
 * the source spreadsheet had in fact been using for transformer serial numbers.
 * Those are now one value and one column, and the serials live in `serialNo`.
 *
 * A cancelled booking stays on the plan, struck through: people need to see
 * that a committee they were preparing for is no longer coming.
 */
export type BookingStatus = 'PLANNED' | 'CANCELLED';

export type BookingDataSource = 'MANUAL' | 'ERP' | 'IMPORT';

/** A value held by any configured plan field. */
export type PlanFieldValue = string | number | boolean | null;

export interface Booking {
  id: string;
  /** Calendar date, `YYYY-MM-DD`. Never a timestamp (spec §9). */
  bookingDate: string;
  /** Wall-clock time, `HH:MM`. */
  bookingTime: string;
  /** Derived from bookingDate, never stored (spec §11). */
  displayDay: string;

  offNo: string | null;
  orderName: string | null;
  committee: string | null;
  qty: number | null;
  kva: number | null;
  kv: string | null;
  /** The booking's lifecycle. Changed by cancelling, never by typing. */
  status: BookingStatus;
  /**
   * Transformer serial or reference number.
   *
   * Text, and never parsed as one: leading zeros are significant, and a single
   * cell routinely holds several references joined by hyphens —
   * `010662606B-020662606B-030662606B`.
   */
  serialNo: string | null;
  notes: string | null;
  customerName: string | null;

  /** Values for CUSTOM plan fields, keyed by fieldKey. */
  customFields: Record<string, PlanFieldValue>;

  /**
   * The engineer responsible for this project being on the plan.
   *
   * Not the same question as `createdBy`, which records the account that wrote
   * the row. They match for an ordinary booking and diverge the moment anyone
   * imports a sheet or works on someone else's behalf — so an import leaves this
   * null rather than claiming the importer owns every project in the file.
   *
   * Cancelling or editing a booking never reassigns it.
   */
  projectEngineer: UserRef | null;

  cancelledBy: UserRef | null;
  cancelledAt: string | null;
  cancellationReason: string | null;

  /**
   * Set when a booking is deleted — which means it should never have existed,
   * not that the committee is no longer coming. Deleted bookings leave the plan
   * but stay answerable in the history.
   */
  deletedBy: UserRef | null;
  deletedAt: string | null;

  dataSource: BookingDataSource;
  externalReference: string | null;

  createdBy: UserRef;
  createdAt: string;
  updatedBy: UserRef;
  updatedAt: string;

  /** Optimistic-concurrency token. Send it back on every update (spec §48). */
  version: number;
}

/**
 * A shared Committee Session: one committee sitting at one date and time,
 * holding any number of project bookings.
 *
 * CONFIRMED business rule (spec §46, §78.1): Date + Time + Committee is a
 * grouping, never a uniqueness key. Adding a project to an occupied session is
 * normal and is never rejected.
 */
export interface SessionPreview {
  bookingDate: string;
  bookingTime: string;
  committee: string | null;
  /** How many active bookings already sit in this session. */
  count: number;
  bookings: Array<{
    id: string;
    offNo: string | null;
    orderName: string | null;
    customerName: string | null;
    status: string | null;
    createdBy: UserRef;
  }>;
}

export interface BookingListQuery {
  from?: string;
  to?: string;
  search?: string;
  committee?: string;
  status?: string;
  createdBy?: string;
  includeCancelled?: boolean;
}

export interface BookingListResponse {
  bookings: Booking[];
  /** Distinct values present in the range, for populating filter menus. */
  facets: {
    committees: string[];
    statuses: string[];
    /**
     * The engineers who own projects in the range.
     *
     * Was `creators`, which after an import listed one person for the whole
     * month — the account that uploaded the file, not the people whose projects
     * were in it.
     */
    engineers: UserRef[];
  };
  range: { from: string; to: string };
}

/**
 * Booking write payload.
 *
 * Values are addressed by plan-field key so one dynamic form drives create and
 * update without the client knowing which keys are columns and which are JSONB
 * (spec §35, §77).
 */
export interface BookingWriteRequest {
  values: Record<string, PlanFieldValue>;
}

export interface UpdateBookingRequest extends BookingWriteRequest {
  /** The version the editor was working from. Mismatch yields 409 (spec §48). */
  version: number;
}

export interface CancelBookingRequest {
  version: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Audit and activity (spec §13, §14)
// ---------------------------------------------------------------------------

/**
 * What happened to a booking.
 *
 * CANCEL and DELETE are deliberately separate: one says a real committee is no
 * longer coming, the other says the row should never have existed. Showing a
 * deletion as a cancellation would lose the difference the moment anyone read
 * the plan's history.
 */
export type BookingHistoryAction = 'CREATE' | 'UPDATE' | 'CANCEL' | 'DELETE';

export interface BookingFieldChange {
  fieldKey: string;
  /** Label at read time, so history stays readable after a rename. */
  label: string;
  from: PlanFieldValue;
  to: PlanFieldValue;
}

export interface BookingHistoryEntry {
  id: number;
  bookingId: string;
  action: BookingHistoryAction;
  actor: UserRef | null;
  bookingVersion: number;
  changes: BookingFieldChange[];
  createdAt: string;
}

export interface ActivityEntry extends BookingHistoryEntry {
  /** Denormalised booking context so the feed renders without N+1 lookups. */
  booking: {
    id: string;
    offNo: string | null;
    orderName: string | null;
    committee: string | null;
    bookingDate: string;
    status: BookingStatus;
    /** A deleted booking keeps its history; the feed says so rather than hiding it. */
    deleted: boolean;
  } | null;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface BookingHistoryResponse {
  entries: BookingHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Settings (the specification's open business rules, §78)
// ---------------------------------------------------------------------------

/**
 * How exclusive a committee slot is.
 *
 * CONFIRMED as `NONE`: committee sessions are shared (see `SessionPreview`).
 * The other values remain available so the rule can be tightened later without
 * a migration or a redeploy.
 */
export type SlotUniqueness = 'NONE' | 'DATE' | 'DATE_TIME' | 'DATE_TIME_COMMITTEE';

export type BookingEditPolicy = 'ANY_ENGINEER' | 'CREATOR_ONLY' | 'CREATOR_OR_PLAN_MANAGER';

export type NotificationAudience = 'ALL_ACTIVE_USERS' | 'ENGINEERS_ONLY';

export interface AppSettings {
  bookingSlotUniqueness: SlotUniqueness;
  bookingEditPolicy: BookingEditPolicy;
  /** null means no horizon limit. */
  bookingFutureHorizonMonths: number | null;
  notificationAudience: NotificationAudience;
}

export type UpdateAppSettingsRequest = Partial<AppSettings>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'SLOT_CONFLICT'
  | 'RATE_LIMITED'
  | 'INVALID_CSRF_TOKEN'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface FieldIssue {
  /** Plan-field key or request path the problem belongs to. */
  field: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    issues?: FieldIssue[];
    /** Present on VERSION_CONFLICT so the UI can offer the current state. */
    currentVersion?: number;
    /** Present on SLOT_CONFLICT: the bookings already occupying the slot. */
    conflictingBookings?: Array<{
      id: string;
      offNo: string | null;
      bookingDate: string;
      bookingTime: string;
      committee: string | null;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

export interface LoginRequest {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface ChangePasswordRequest {
  currentPassword?: string;
  newPassword: string;
}

export interface SessionResponse {
  user: CurrentUser;
  settings: AppSettings;
  csrfToken: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  checks: {
    database: 'ok' | 'error';
  };
}

// ---------------------------------------------------------------------------
// Committee Plan import (spec §5, §28, §39)
// ---------------------------------------------------------------------------

export type ImportFileType = 'XLSX' | 'XLS' | 'CSV';
export type ImportBatchStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Whether a parsed row can be imported as it stands. */
export type ImportRowStatus = 'valid' | 'warning' | 'error';

export interface ImportRowIssue {
  /** The plan field the issue belongs to, or null for a whole-row issue. */
  fieldKey: string | null;
  label: string;
  message: string;
  severity: 'warning' | 'error';
}

/**
 * An existing booking that looks like the row being imported.
 *
 * Advisory only. A shared Committee Session — several projects at the same
 * date, time and committee — is never a duplicate (spec §46, §78.1).
 */
export interface ImportDuplicateMatch {
  bookingId: string;
  offNo: string | null;
  bookingDate: string;
  bookingTime: string;
  committee: string | null;
  message: string;
}

export type ImportMappingConfidence = 'exact' | 'likely' | 'uncertain';

export interface ImportColumnSuggestion {
  header: string;
  index: number;
  /** Null means the user has to choose; the importer will not guess. */
  suggestedFieldKey: string | null;
  confidence: ImportMappingConfidence;
  reason: string | null;
  sampleValues: string[];
}

export interface ImportPreviewRow {
  index: number;
  /** 1-based row in the uploaded sheet, so errors can name "Row 14". */
  sourceRowNumber: number;
  status: ImportRowStatus;
  issues: ImportRowIssue[];
  values: Record<string, PlanFieldValue>;
  display: Record<string, string>;
  duplicate: ImportDuplicateMatch | null;
}

export interface ImportPreviewSummary {
  total: number;
  valid: number;
  warnings: number;
  errors: number;
  duplicates: number;
}

export interface ImportPreviewField {
  fieldKey: string;
  label: string;
  isRequired: boolean;
  fieldType: string;
}

export interface ImportPreviewResponse {
  batchId: string;
  filename: string;
  fileType: ImportFileType;
  fileSizeBytes: number;
  sheetName: string;
  availableSheets: string[];
  /** True when the row cap trimmed the sheet. */
  truncated: boolean;
  columns: ImportColumnSuggestion[];
  mapping: Record<string, string | null>;
  fields: ImportPreviewField[];
  rows: ImportPreviewRow[];
  summary: ImportPreviewSummary;
}

export interface ImportBatch {
  id: string;
  originalFilename: string;
  fileType: ImportFileType;
  fileSizeBytes: number;
  sheetName: string | null;
  status: ImportBatchStatus;
  columnMapping: Record<string, string | null>;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  importedRows: number;
  skippedRows: number;
  firstBookingDate: string | null;
  lastBookingDate: string | null;
  failureReason: string | null;
  uploadedBy: UserRef;
  uploadedAt: string;
  completedAt: string | null;
}

export interface ImportConfirmResponse {
  batch: ImportBatch;
  importedRows: number;
  skippedRows: number;
}

export interface ImportBatchListResponse {
  batches: ImportBatch[];
  page: number;
  limit: number;
  hasMore: boolean;
}
