import type {
  WhatsAppAccountStatus,
  WhatsAppBusinessVerificationStatus,
  WhatsAppQualityRating,
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

export const QUALITY_RATING_TONES: Record<WhatsAppQualityRating, BadgeTone> = {
  green: 'success',
  yellow: 'warning',
  red: 'danger',
  // Meta has looked and cannot place the number. A settled state, not a problem.
  unknown: 'neutral',
};

export const ACCOUNT_STATUS_TONES: Record<WhatsAppAccountStatus, BadgeTone> = {
  connected: 'success',
  disconnected: 'neutral',
  error: 'danger',
};
