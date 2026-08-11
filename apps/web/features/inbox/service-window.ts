/**
 * Meta's 24-hour customer service window, as the composer reads it.
 *
 * This mirrors `isServiceWindowOpen` on the API side, and mirrors it exactly on
 * purpose: the API refuses a free-form send outside the window with
 * `whatsapp_window_expired`, and a console that disagreed by a second would
 * either offer a send that cannot succeed or hide one that can.
 *
 * The three rules it copies, for the same reasons stated there:
 *
 *   * **No duration lives here.** The window is opened by an inbound message and
 *     stamped on `conversations.service_window_expires_at` by the one writer that
 *     records one. This side reads the column and nothing else.
 *   * **`null` is closed**, not unknown — a thread with no inbound message has no
 *     window, and treating that as "allow" would produce a failed send an agent
 *     could not explain.
 *   * **The boundary is exclusive.** At exactly `expiresAt` the window is shut.
 */

export type ServiceWindow =
  /** A free-form message may be sent until `expiresAt`. */
  | { readonly state: 'open'; readonly expiresAt: string }
  /** Template only. Covers both an expiry in the past and a thread that never had one. */
  | { readonly state: 'closed' };

export function serviceWindowAt(serviceWindowExpiresAt: string | null, now: Date): ServiceWindow {
  if (serviceWindowExpiresAt === null) {
    return CLOSED;
  }

  const expiresAt = Date.parse(serviceWindowExpiresAt);

  // An unparseable timestamp is closed, not open: the safe direction of the two
  // is the one that costs an agent a template rather than a message the customer
  // never receives.
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) {
    return CLOSED;
  }

  return { state: 'open', expiresAt: serviceWindowExpiresAt };
}

/** How long an open window has left, in milliseconds. Never negative. */
export function msUntilClose(window: ServiceWindow, now: Date): number {
  if (window.state === 'closed') {
    return 0;
  }

  return Math.max(0, Date.parse(window.expiresAt) - now.getTime());
}

const CLOSED: ServiceWindow = { state: 'closed' };
