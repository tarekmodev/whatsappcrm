/**
 * Meta's 24-hour customer service window, as the send path reads it.
 *
 * Inside the window an agent may send anything. Outside it, WhatsApp accepts
 * only a template the business has had approved — a free-form message is
 * refused by Meta with an opaque provider error, which is why this is checked
 * here and answered as `whatsapp_window_expired` before the Cloud API is ever
 * called.
 *
 * ## Why this file holds no duration
 *
 * The window is *opened* by an inbound message, and `WhatsAppInboundWriter`
 * stamps `conversations.service_window_expires_at` when it records one. That is
 * the only writer, and the 24 hours live there with it. This side reads the
 * column and nothing else — so the two cannot drift, because there is only one
 * number and this file does not have a copy of it.
 *
 * ## `null` is closed, and that is not a special case
 *
 * A thread with no inbound message has no window: one opened by a delivery
 * receipt, or by an agent reaching out first. `null` therefore means the same
 * thing as an expiry in the past — only a template may be sent — and treating
 * it as "unknown, allow" would turn every such thread into a failed send the
 * agent could not explain.
 *
 * ## The boundary is exclusive
 *
 * `expiresAt` is when the window closes, so a message sent at exactly that
 * instant is outside it. Millisecond-exact agreement with Meta's own clock is
 * not achievable — `sent_at` is Meta's timestamp in whole seconds and the
 * comparison happens on our clock — so a send inside the last second of the
 * window can still be refused by Meta. That is the safe direction of the two:
 * refusing early costs an agent one template, while allowing late costs a
 * message the customer never receives and a provider error nobody can read.
 */

/** Exactly what the rule reads, so a caller cannot pass a whole row by accident. */
export interface ServiceWindow {
  readonly serviceWindowExpiresAt: Date | null;
}

export function isServiceWindowOpen({ serviceWindowExpiresAt }: ServiceWindow, now: Date): boolean {
  return serviceWindowExpiresAt !== null && serviceWindowExpiresAt.getTime() > now.getTime();
}
