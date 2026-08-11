/**
 * How long to wait before minting a new ticket and opening the socket again.
 *
 * Capped exponential backoff with jitter. The cap keeps a console that has been
 * open all night from drifting into hour-long gaps; the jitter is what stops
 * every tab in a tenant reconnecting on the same millisecond after an API
 * restart and turning a deploy into a self-inflicted load test.
 *
 * Pure and injectable so the schedule is a tested table rather than something
 * observed in a browser.
 */

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** `attempt` is zero-based: the first retry after a drop is attempt 0. */
export function reconnectDelayMs(attempt: number, jitter: number = Math.random()): number {
  const capped = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);

  // Full jitter over [capped/2, capped]: still backs off, never synchronises.
  return Math.round(capped / 2 + (capped / 2) * clampUnit(jitter));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
