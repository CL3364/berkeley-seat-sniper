import type { SeatState } from '../shared/seat-state';
import type { PersistedDashboardObservations } from './types';

/**
 * Normalize the parser's omission-tolerant SeatState into the worker/DB
 * boundary's explicit nullable snapshot. A successful 200 calls this for every
 * write, so markup observed as absent clears a previously stored value.
 */
export function dashboardObservationsForPersistence(
  state: SeatState,
): PersistedDashboardObservations {
  return {
    displayName: state.displayName ?? null,
    lastEnrolled: state.enrolled ?? null,
    lastCapacity: state.capacity ?? null,
    lastWaitlisted: state.waitlisted ?? null,
    lastWaitlistMax: state.waitlistMax ?? null,
    lastOpenReserved: state.openReserved ?? null,
  };
}
