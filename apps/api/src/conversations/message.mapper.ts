import type { MessageAttachment, MessageResponse, MessageStatus } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { MessageStatus as StoredMessageStatus } from '../generated/prisma/enums';

/**
 * `messages` → `MessageResponse`.
 *
 * Three of the published fields are not columns, and each is a decision rather
 * than a lookup.
 *
 * ## `status`: the stored ladder has six rungs, the published one has five
 *
 * `message_status` carries `received`, which the contract does not: it is the
 * terminal state of an **inbound** message, and `MESSAGE_STATUSES` describes an
 * outbound lifecycle. The contract answers what to publish instead —
 * "inbound messages are born `delivered`; there is nothing to track" — so
 * `received` maps to `delivered`, and every other value passes through
 * unchanged.
 *
 * Mapping rather than adding `received` to the contract: the ranks in
 * `MESSAGE_STATUS_RANK` are what stop a late webhook un-reading a message, and
 * a sixth value with no place on that ladder would have to be given one it does
 * not have. An inbound message *is* delivered — it is in our hands.
 *
 * ## `origin` is the column, and `sentByAutomation` is derived from it
 *
 * TAR-28 shipped `messages.origin` (0010 decision 14), because "outbound with no
 * sender" was about to stop being a useful fact: the chatbot and TAR-27's
 * workflows will both write rows with a null sender, and the console has to
 * badge exactly one of them.
 *
 * `sentByAutomation` keeps its published meaning — "the chatbot or a workflow
 * produced this" — now read as `origin` being neither `contact` nor `agent`. For
 * every row this codebase has ever written, the two definitions agree: the
 * migration backfilled `agent` for outbound rows with a sender and `system` for
 * the rest, and a trigger completes any writer that does not name one.
 *
 * The placeholder case is the one worth naming: a delivery receipt that
 * overtakes its own message produces a row with no sender, so it reports
 * `sentByAutomation: true` and `origin: 'system'` for a message an agent did
 * send. It corrects itself the moment the send path's own row wins the race,
 * which it does on every send this API performs.
 *
 * ## `attachments[].url`: absolute, and built here
 *
 * `message_attachments.url` holds a **path**, deliberately: the same row is
 * served through a tenant's platform subdomain and through its custom domain
 * (TAR-29), so an absolute URL in the column would name whichever host was
 * configured the day it was written. The contract publishes a `z.url()`, so the
 * origin is joined on at the response boundary — which is this function, from
 * the host `HostTenantGuard` resolved for *this* request.
 */

/**
 * Attachments in insertion order. Declared with its type rather than inline:
 * the projection is `as const` so the payload type can read its literal `true`s,
 * which would otherwise make this readonly — and Prisma's input types are not.
 */
const BY_ID: Prisma.MessageAttachmentOrderByWithRelationInput = { id: 'asc' };

export const MESSAGE_PROJECTION = {
  id: true,
  conversationId: true,
  direction: true,
  contentType: true,
  status: true,
  body: true,
  senderUserId: true,
  origin: true,
  providerMessageId: true,
  errorCode: true,
  errorMessage: true,
  sentAt: true,
  createdAt: true,
  attachments: {
    select: {
      id: true,
      providerMediaId: true,
      url: true,
      kind: true,
      downloadState: true,
      mimeType: true,
      filename: true,
      sizeBytes: true,
    },
    orderBy: BY_ID,
  },
} as const satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_PROJECTION }>;

/**
 * @param origin scheme and host this response is being served on, without a
 *   trailing slash — `https://acme.example`. Required rather than optional: a
 *   missing origin would publish a relative URL that fails the contract's own
 *   schema, and there is no correct default for a value that is a property of
 *   the request.
 */
export function toMessageResponse(message: MessageRow, origin: string): MessageResponse {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.contentType,
    status: toPublishedStatus(message.status),
    body: message.body,
    attachments: message.attachments.map((attachment) => toAttachment(attachment, origin)),
    sentByUserId: message.senderUserId,
    sentByAutomation: message.origin !== 'contact' && message.origin !== 'agent',
    origin: message.origin,
    providerMessageId: message.providerMessageId,
    failureReason: toFailureReason(message.errorCode, message.errorMessage),
    sentAt: message.sentAt.toISOString(),
    createdAt: message.createdAt.toISOString(),
  };
}

function toPublishedStatus(status: MessageRow['status']): MessageStatus {
  return status === StoredMessageStatus.received ? 'delivered' : status;
}

function toAttachment(
  attachment: MessageRow['attachments'][number],
  origin: string,
): MessageAttachment {
  return {
    id: attachment.id,
    providerMediaId: attachment.providerMediaId,
    url: attachment.url === null ? null : `${origin}${attachment.url}`,
    kind: attachment.kind,
    downloadState: attachment.downloadState,
    mimeType: attachment.mimeType,
    fileName: attachment.filename,
    sizeBytes: attachment.sizeBytes,
  };
}

/**
 * Meta's code and title as one string, for a message that failed.
 *
 * Both columns are null on every other row, so the join happens here rather
 * than being stored: the pair is what an agent needs to read, and the two
 * columns are what a report needs to group by.
 */
function toFailureReason(code: string | null, message: string | null): string | null {
  if (code === null && message === null) {
    return null;
  }

  return [code, message].filter((part): part is string => part !== null && part !== '').join(': ');
}
