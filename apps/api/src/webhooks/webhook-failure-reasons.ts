/**
 * Why an event was parked, as a stable prefix on `webhook_events.last_error`.
 *
 * These are operational vocabulary, not prose: an on-call engineer answers
 * "what is stuck and why" with
 * `SELECT last_error, count(*) FROM webhook_events WHERE status = 'failed'
 *  GROUP BY 1`, and that only works if the reason is a fixed token rather than a
 * message someone reworded. Detail goes after the token.
 */
export const WEBHOOK_FAILURE_REASON = {
  /**
   * No tenant has connected this `phone_number_id`. Usually a number connected
   * before its tenant record existed. The payload is kept so it can be replayed
   * once the tenant is there — discarding it would lose real customer messages.
   */
  unknownPhoneNumber: 'unknown_phone_number_id',
  /** The signed payload did not match the shape the processor understands. */
  unrecognisedPayload: 'payload_unrecognised',
  /** A `wa_id` that is not a phone number: there is no contact to attribute it to. */
  unroutableContact: 'unroutable_contact',
  /**
   * The tenant is deactivated (TAR-51). Its data is retained and its access is
   * revoked, so an inbound message is parked rather than written — and stays
   * replayable if the tenant is reactivated.
   */
  tenantNotActive: 'tenant_not_active',
  /** The retry budget is spent. The last failure follows the token. */
  attemptsExhausted: 'attempts_exhausted',
} as const;

export type WebhookFailureReason =
  (typeof WEBHOOK_FAILURE_REASON)[keyof typeof WEBHOOK_FAILURE_REASON];

/** `reason: detail`, so the token stays the first thing on the line. */
export function describeFailure(reason: WebhookFailureReason, detail: string): string {
  return `${reason}: ${detail}`;
}
