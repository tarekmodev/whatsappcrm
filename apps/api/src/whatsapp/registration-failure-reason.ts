import {
  WHATSAPP_REGISTRATION_FAILURE_REASONS,
  type WhatsAppRegistrationFailureReason,
} from '@whatsappcrm/contracts';

/**
 * Reads `whatsapp_accounts.registration_failure_reason` back as the published
 * vocabulary (TAR-170).
 *
 * The column is `TEXT` rather than an enum type — the vocabulary grows as Meta's
 * failure codes are mapped, and only this codebase ever writes it — so the
 * narrowing happens here, in one place, on the way out.
 *
 * **A value this build does not recognise reads as `rejected`.** That is the same
 * rule `MetaCloudApiClient` applies to Meta statuses it does not model, and it is
 * what makes a rollback across an addition to the vocabulary safe: a row written
 * by a newer version renders as an unmodelled refusal — which is exactly what it
 * is to this reader — rather than failing the response schema on every read.
 */
export function readRegistrationFailureReason(
  stored: string | null,
): WhatsAppRegistrationFailureReason | null {
  if (stored === null) {
    return null;
  }

  return (WHATSAPP_REGISTRATION_FAILURE_REASONS as readonly string[]).includes(stored)
    ? (stored as WhatsAppRegistrationFailureReason)
    : 'rejected';
}
