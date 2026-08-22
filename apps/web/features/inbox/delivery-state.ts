import type { MessageResponse, MessageStatus } from '@whatsappcrm/contracts';
import type { IconName } from '@/components/ui/Icon';

/**
 * How an outbound message's delivery state reads on its bubble (TAR-518).
 *
 * `packages/contracts/src/messages.ts` already publishes the ladder — `queued →
 * sent → delivered → read`, or `failed` — and the API already writes it with a
 * monotonic guard, so nothing here derives state. This is only the mapping onto
 * a glyph, which is the part a component would otherwise hold.
 *
 * Inbound messages have no delivery state to show: the contract says they are
 * born `delivered`, and a tick on the customer's own words would claim we
 * delivered something to ourselves.
 */

export const DELIVERY_ICONS = {
  queued: 'clock',
  sent: 'tick',
  delivered: 'tickDouble',
  read: 'tickDouble',
  failed: 'alert',
} as const satisfies Record<MessageStatus, IconName>;

export function hasDeliveryState(message: MessageResponse): boolean {
  return message.direction === 'outbound';
}

/**
 * Whether this failed message can be sent again from the bubble.
 *
 * Only a text body, and only with nothing attached. WhatsApp carries one media
 * object per message and `SendMediaInput` names the **upload's** id — which a
 * delivered `MessageAttachment` does not publish; it carries its own row id and
 * Meta's expiring handle, and neither is the one a send takes. So a failed photo
 * cannot be rebuilt from what the thread knows, and a button that quietly sent
 * the caption without the picture would be worse than no button: the agent would
 * believe the customer had the file.
 *
 * That case gets a line telling them to attach it again instead.
 */
export function canRetrySend(message: MessageResponse): boolean {
  return (
    message.status === 'failed' &&
    message.direction === 'outbound' &&
    message.attachments.length === 0 &&
    (message.body?.trim() ?? '') !== ''
  );
}
