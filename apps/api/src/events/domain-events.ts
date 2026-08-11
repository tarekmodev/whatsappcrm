import type {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '../generated/prisma/enums';

/**
 * The in-process domain event bus (`@nestjs/event-emitter`, TAR-39: "two event
 * buses, chosen by durability"). Everything here is same-request fan-out where
 * loss is acceptable — a socket relay, a cache bust. Anything that must survive
 * a restart goes on BullMQ instead.
 *
 * These shapes live outside every feature module on purpose. `WebhooksModule`
 * (L2) emits them and `RealtimeModule` (L1) subscribes; the layering rule
 * forbids either importing the other, so what they share is a type, not a class.
 *
 * **Not an API contract.** The socket payload is a full `MessageResponse` from
 * `@whatsappcrm/contracts` (TAR-39, realtime: "payloads are whole resources").
 * These carry what the emitter already has in hand so the subscriber can build
 * that response without a second round trip, and may change with the schema.
 */

export const MESSAGE_CREATED_EVENT = 'message.created';
export const MESSAGE_STATUS_CHANGED_EVENT = 'message.status_changed';

/**
 * A message row that did not exist before — inbound from a webhook, or the
 * placeholder a status webhook creates when it overtakes the message it
 * describes.
 */
export interface MessageCreatedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly messageId: string;
  readonly direction: MessageDirection;
  readonly status: MessageStatus;
  readonly contentType: MessageContentType;
  readonly body: string | null;
  readonly providerMessageId: string | null;
  /** The provider's timestamp, never insert order (TAR-39, ordering). */
  readonly sentAt: Date;
}

/**
 * An existing message whose status moved **forward**. A status webhook that does
 * not advance the ladder is applied to nothing and emits nothing, so a late
 * `sent` never reaches a client as an un-read.
 */
export interface MessageStatusChangedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly status: MessageStatus;
  readonly providerMessageId: string;
}
