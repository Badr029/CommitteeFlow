import type { PillTone } from '@/components/ui/Pill';
import type { BookingStatus } from '@shared/api-types';

/**
 * How a booking's status reads on screen.
 *
 * Status used to be a free-text plan field with no fixed vocabulary, so this
 * guessed a tone from the wording. It has two values now — the lifecycle and
 * nothing else — and the guessing is gone with the ambiguity.
 *
 * `Cancelled` is a warning rather than a danger: the booking is still on the
 * plan on purpose, so people can see that a committee they were preparing for
 * is no longer coming. Painting it as an error would say something went wrong,
 * when cancelling is an ordinary thing to do.
 */
export function statusLabel(status: BookingStatus): string {
  return status === 'CANCELLED' ? 'Cancelled' : 'Planned';
}

export function toneForStatus(status: BookingStatus): PillTone {
  return status === 'CANCELLED' ? 'warn' : 'neutral';
}
