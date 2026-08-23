import type {
  WhatsAppAccountStatus,
  WhatsAppBusinessVerificationStatus,
  WhatsAppRegistrationFailureReason,
  WhatsAppRegistrationStatus,
} from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * Maps Meta's own states onto presentation, on the same pattern the People
 * feature uses: kept out of the components so the connection card and anything
 * added later label a state identically, and so a new state means editing one
 * table.
 *
 * Tone never carries the meaning on its own — every badge in this feature shows
 * the label from the content layer beside it.
 */

export const VERIFICATION_STATUS_TONES: Record<WhatsAppBusinessVerificationStatus, BadgeTone> = {
  not_verified: 'neutral',
  pending: 'warning',
  verified: 'success',
  rejected: 'danger',
};

/*
 * There is no quality-rating tone table, and its absence is a decision rather
 * than an omission.
 *
 * 0001 gives a table row a budget of two chips, ranked most-actionable first,
 * and on a WhatsApp number that ranking is: whether Meta will let it send, then
 * whether Meta can reach it, then what Meta thinks of it. Quality comes third,
 * so it renders as `Badge variant="quiet"` — which ignores tone by design — and
 * a table mapping ratings onto tones would be a table nothing reads. See
 * `numberColumns` in `ConnectedBusinessAccount.tsx` for the full ranking.
 */

export const ACCOUNT_STATUS_TONES: Record<WhatsAppAccountStatus, BadgeTone> = {
  connected: 'success',
  disconnected: 'neutral',
  error: 'danger',
};

/**
 * Whether a number may send, as a chip.
 *
 * `unregistered` is `warning` and not `neutral`, which is the one judgement in
 * this table: a number that has never been registered receives normally and
 * refuses every send, and drawing that as an ordinary resting state is exactly
 * the silent-inbox failure the second status axis exists to make visible.
 *
 * `pending` is `info` — an attempt is in flight, or one died without an answer.
 * Nothing to do but look again, which is not a warning.
 */
export const REGISTRATION_STATUS_TONES: Record<WhatsAppRegistrationStatus, BadgeTone> = {
  unregistered: 'warning',
  pending: 'info',
  registered: 'success',
  failed: 'danger',
};

/**
 * Whether pressing the button again could produce a different answer.
 *
 * Offered only where it could. `pin_rejected` and `credential_rejected` name
 * something that has to change elsewhere first — a two-step-verification PIN
 * this platform does not hold, an access token Meta has invalidated — and
 * sending somebody back through the same request to be told the same thing is
 * how a retry stops meaning anything. `already_registered` needs no retry
 * because there is nothing left to do.
 *
 * The same shape as `isConnectFailureRetryable`, and for the same reason: copy
 * stays copy, and whether a control appears is a decision.
 */
export function isRegistrationFailureRetryable(reason: WhatsAppRegistrationFailureReason): boolean {
  return reason === 'rate_limited' || reason === 'upstream_unavailable' || reason === 'rejected';
}

/**
 * Whether the way out of this refusal is to connect the WABA again.
 *
 * Only `credential_rejected`: the stored access token is expired, revoked, or
 * missing a permission, and Embedded Signup is what issues a new one. Sending
 * anyone else back through Meta's window would spend a run on a problem it
 * cannot fix.
 */
export function isRegistrationFailureReconnectable(
  reason: WhatsAppRegistrationFailureReason,
): boolean {
  return reason === 'credential_rejected';
}
