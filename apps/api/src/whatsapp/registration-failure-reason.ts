import {
  WHATSAPP_REGISTRATION_FAILURE_REASONS,
  type WhatsAppRegistrationFailureReason,
} from '@whatsappcrm/contracts';

/**
 * `whatsapp_accounts.registration_failure_reason` is `TEXT`, so what comes back
 * out of it is a `string` and the published union is narrower than the column.
 *
 * A value this build does not model is reported as `rejected` rather than
 * thrown away or passed through: `rejected` is exactly what it means — Meta
 * refused for a reason this version cannot name — and it keeps the console's
 * six strings exhaustive. That is what makes a rollback across an addition to
 * the vocabulary a display change rather than a deserialisation failure, and it
 * is the same fail-honest rule `MetaCloudApiClient` applies to Meta statuses it
 * does not know.
 *
 * Shared by the registration service and the connect-response mapper so the two
 * cannot disagree about what a stored reason means.
 */
export function toWhatsAppRegistrationFailureReason(
  stored: string | null,
): WhatsAppRegistrationFailureReason | null {
  if (stored === null) {
    return null;
  }

  return isFailureReason(stored) ? stored : 'rejected';
}

function isFailureReason(value: string): value is WhatsAppRegistrationFailureReason {
  return (WHATSAPP_REGISTRATION_FAILURE_REASONS as readonly string[]).includes(value);
}
