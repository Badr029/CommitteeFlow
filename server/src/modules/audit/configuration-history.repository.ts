import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';

/**
 * Plan-configuration audit trail (spec §25).
 *
 * Written by the application only. There is deliberately no API that updates or
 * deletes a row here (spec §67).
 */

export type ConfigurationHistoryAction = 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'RESTORE' | 'REORDER';

export interface ConfigurationChangeInput {
  fieldId: string | null;
  fieldKey: string;
  action: ConfigurationHistoryAction;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
}

export async function recordConfigurationChange(
  input: ConfigurationChangeInput,
  executor?: Queryable,
): Promise<void> {
  await queryOne(
    `INSERT INTO configuration_history
       (field_id, field_key, action, old_value, new_value, changed_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      input.fieldId,
      input.fieldKey,
      input.action,
      input.oldValue === null || input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
      input.newValue === null || input.newValue === undefined ? null : JSON.stringify(input.newValue),
      input.changedBy,
    ],
    executor,
  );
}

export interface ConfigurationHistoryEntry {
  id: number;
  fieldId: string | null;
  fieldKey: string;
  action: ConfigurationHistoryAction;
  oldValue: unknown;
  newValue: unknown;
  changedBy: { id: string; name: string; email: string } | null;
  changedAt: string;
}

export async function listConfigurationHistory(
  limit: number,
  offset: number,
  executor?: Queryable,
): Promise<ConfigurationHistoryEntry[]> {
  const rows = await queryRows<{
    id: number;
    field_id: string | null;
    field_key: string;
    action: ConfigurationHistoryAction;
    old_value: unknown;
    new_value: unknown;
    changed_by_id: string | null;
    changed_by_name: string | null;
    changed_by_email: string | null;
    changed_at: Date;
  }>(
    `SELECT ch.id,
            ch.field_id,
            ch.field_key,
            ch.action,
            ch.old_value,
            ch.new_value,
            u.id    AS changed_by_id,
            u.name  AS changed_by_name,
            u.email AS changed_by_email,
            ch.changed_at
       FROM configuration_history ch
       LEFT JOIN users u ON u.id = ch.changed_by
      ORDER BY ch.changed_at DESC, ch.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
    executor,
  );

  return rows.map((row) => ({
    id: row.id,
    fieldId: row.field_id,
    fieldKey: row.field_key,
    action: row.action,
    oldValue: row.old_value,
    newValue: row.new_value,
    changedBy:
      row.changed_by_id && row.changed_by_name && row.changed_by_email
        ? { id: row.changed_by_id, name: row.changed_by_name, email: row.changed_by_email }
        : null,
    changedAt: row.changed_at.toISOString(),
  }));
}
