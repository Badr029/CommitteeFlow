import type { PlanField } from '@shared/api-types';

/**
 * Grouping the booking form into sections.
 *
 * A phone shows one field per row, so eleven configured fields become a long
 * undifferentiated scroll. Sections give it structure — but they must not become
 * a second, hardcoded schema: Plan Configuration stays the only source of which
 * fields exist, what they are called, whether they are required and what order
 * they come in (spec §35, §77).
 *
 * So the grouping keys off `fieldKey`, which the spec fixes as permanent (§20) —
 * a field renamed from "Customer" to "Customer Name" keeps `customer_name` and
 * stays in the same section. Anything unrecognised, including every custom
 * field, falls to "Additional details". Within a section the configured
 * `displayOrder` is preserved, so reordering in Plan Configuration still moves
 * fields here.
 */

export interface FormSection {
  id: string;
  title: string;
  /** Shown under the title where the grouping itself needs explaining. */
  hint?: string;
  fields: PlanField[];
}

/** Which section each known field belongs to. Custom keys are absent by design. */
const SECTION_OF: Record<string, string> = {
  booking_date: 'schedule',
  booking_time: 'schedule',
  committee: 'schedule',
  off_no: 'project',
  order_name: 'project',
  customer_name: 'project',
  qty: 'technical',
  kva: 'technical',
  kv: 'technical',
  serial_no: 'technical',
};

/**
 * Fields the application fills in, which no form should offer.
 *
 * Status moves through the explicit Cancel action, and Project Engineer is
 * whoever is signed in — so putting either on the form would be offering a
 * control that the server refuses. They still appear on the plan, in the
 * booking's details and in the exports; they are simply not typed.
 *
 * Kept in step with READ_ONLY_FIELD_KEYS on the server, which is what actually
 * enforces it.
 */
const NEVER_ON_THE_FORM = new Set(['status', 'project_engineer']);

const SECTION_ORDER: Array<{ id: string; title: string; hint?: string }> = [
  {
    id: 'schedule',
    title: 'Schedule',
    hint: 'Which committee sits, and when. Several projects can share one sitting.',
  },
  { id: 'project', title: 'Project' },
  { id: 'technical', title: 'Technical' },
  { id: 'additional', title: 'Additional details' },
];

export function groupFieldsIntoSections(fields: readonly PlanField[]): FormSection[] {
  const buckets = new Map<string, PlanField[]>();

  for (const field of [...fields].sort((a, b) => a.displayOrder - b.displayOrder)) {
    if (NEVER_ON_THE_FORM.has(field.fieldKey)) continue;
    const id = SECTION_OF[field.fieldKey] ?? 'additional';
    const bucket = buckets.get(id);
    if (bucket) bucket.push(field);
    else buckets.set(id, [field]);
  }

  return SECTION_ORDER.flatMap((section) => {
    const sectionFields = buckets.get(section.id);
    // A section with nothing in it — every field hidden, say — is not rendered.
    if (!sectionFields || sectionFields.length === 0) return [];
    return [{ ...section, fields: sectionFields }];
  });
}
