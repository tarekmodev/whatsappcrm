import { Inject, Injectable } from '@nestjs/common';
import type { MessageAttachment, MessageResponse, MessageStatus } from '@whatsappcrm/contracts';
import type {
  MediaDownloadState,
  MediaKind,
  MessageContentType,
  MessageDirection,
  MessageStatus as StoredMessageStatus,
} from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { TenantOriginService } from './tenant-origin.service';

/**
 * Turning a message id into the resource a socket publishes.
 *
 * ## Why the relay reads the row back at all
 *
 * The domain event carries what the emitter happened to have in hand, and says
 * so — it is explicitly not an API contract. What goes on the wire is a full
 * `MessageResponse` (TAR-39, realtime: "payloads are whole resources, not
 * deltas"), including the attachments the event does not mention and the
 * timestamps it does not carry. One indexed read per relayed message is what
 * buys a client that can render the event without a refetch, which is the entire
 * point of the payload rule.
 *
 * The read runs on `TenantPrisma` inside the scope the relay opened from the
 * event's own tenant id, so a message id that somehow named another tenant's row
 * resolves to nothing rather than to a payload.
 *
 * ## This is the first of two callers
 *
 * TAR-20d's `GET /conversations/{id}/messages` needs exactly this mapping and
 * does not exist yet. It lives here, with the first consumer, rather than in a
 * shared module built for a caller that has not been written — but it is written
 * as a plain projection and a pure mapper so moving it costs an import.
 */

/**
 * Exactly the columns `MessageResponse` publishes. Named once so the projection
 * cannot widen by accident: `messages` carries per-status timestamps and raw
 * provider error text that the response does not, and a `select` that drifted
 * into `include` would put both on every socket in the tenant.
 */
const MESSAGE_PROJECTION = {
  id: true,
  conversationId: true,
  direction: true,
  status: true,
  contentType: true,
  body: true,
  senderUserId: true,
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
    orderBy: { createdAt: 'asc' },
  },
} as const;

/**
 * The projection above, as a type. Declared rather than inferred from the
 * client, so the pure mapper below can be exercised from a spec with a literal
 * row instead of a Prisma round trip.
 */
export interface RelayableMessageRow {
  readonly id: string;
  readonly conversationId: string;
  readonly direction: MessageDirection;
  readonly status: StoredMessageStatus;
  readonly contentType: MessageContentType;
  readonly body: string | null;
  readonly senderUserId: string | null;
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly sentAt: Date;
  readonly createdAt: Date;
  readonly attachments: readonly RelayableAttachmentRow[];
}

export interface RelayableAttachmentRow {
  readonly id: string;
  readonly providerMediaId: string | null;
  readonly url: string | null;
  readonly kind: MediaKind;
  readonly downloadState: MediaDownloadState;
  readonly mimeType: string;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
}

@Injectable()
export class MessageResourceService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly origins: TenantOriginService,
  ) {}

  /**
   * The message as the API publishes it, or `null` when the row is gone.
   *
   * `null` is not an error the relay should shout about: a message deleted
   * between the commit that emitted the event and this read is a race with a
   * legitimate outcome, and the honest response is to relay nothing.
   */
  async findForRelay(messageId: string): Promise<MessageResponse | null> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: MESSAGE_PROJECTION,
    });

    if (message === null) {
      return null;
    }

    // Only paid for when there is something to make absolute. An inbound
    // attachment is `pending` with a null `url` at `message.created` time, so
    // the common relay never reaches the control plane at all.
    const origin = message.attachments.some((attachment) => attachment.url !== null)
      ? await this.origins.originForTenantInScope()
      : null;

    return toMessageResponse(message, origin);
  }
}

/**
 * Row → response, field by field rather than by rest-spread, so a column added
 * to the projection cannot arrive on a socket by being everything that was not
 * named.
 *
 * Several fields are assigned across without a mapping table on purpose:
 * `direction`, `contentType` and the attachment's `kind` and `downloadState` are
 * the same string unions in the database enum and in the contract, so the
 * assignment itself is the drift check — a value added to one and not the other
 * fails to compile here rather than being cast past.
 */
export function toMessageResponse(
  message: RelayableMessageRow,
  origin: string | null,
): MessageResponse {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.contentType,
    status: toPublishedStatus(message.status),
    body: message.body,
    attachments: message.attachments.map((attachment) => toAttachment(attachment, origin)),
    sentByUserId: message.senderUserId,
    // No column backs this yet: nothing in the product writes a message on a
    // tenant's behalf until TAR-27's workflows and TAR-28's chatbot do, and both
    // add the column that makes this real. Published as `false` rather than
    // omitted so the contract's shape is honoured and the field flips to a read
    // when there is something to read.
    sentByAutomation: false,
    providerMessageId: message.providerMessageId,
    failureReason: toFailureReason(message.errorCode, message.errorMessage),
    sentAt: message.sentAt.toISOString(),
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * The stored status as the contract publishes it.
 *
 * The database has one value the contract does not: `received`, the terminal
 * state of an inbound message. The contract states the intent plainly —
 * "inbound messages are born `delivered`; there is nothing to track" — so this
 * is the published spelling of the same fact rather than a widening of the
 * ladder. Written as a total record instead of a cast, so a status added to the
 * enum fails the build here until somebody decides what a client should see.
 */
const PUBLISHED_STATUSES: Readonly<Record<StoredMessageStatus, MessageStatus>> = {
  received: 'delivered',
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

function toPublishedStatus(status: StoredMessageStatus): MessageStatus {
  return PUBLISHED_STATUSES[status];
}

/**
 * Meta's error code and title, flattened to the one string the contract
 * publishes. Both when both are known, because the title is what an agent reads
 * and the code is what a support conversation with Meta quotes.
 */
function toFailureReason(code: string | null, message: string | null): string | null {
  if (code !== null && message !== null) {
    return `${code}: ${message}`;
  }

  return message ?? code;
}

function toAttachment(
  attachment: RelayableAttachmentRow,
  origin: string | null,
): MessageAttachment {
  return {
    id: attachment.id,
    providerMediaId: attachment.providerMediaId,
    // Null while the bytes are `pending` and permanently null when the download
    // `failed` — the row still records that the customer sent a file, and so
    // does this. Null again when the tenant has no verified host to build an
    // absolute URL from, which is the one case the contract's `z.url()` cannot
    // express any other way.
    url: attachment.url === null || origin === null ? null : `${origin}${attachment.url}`,
    kind: attachment.kind,
    downloadState: attachment.downloadState,
    mimeType: attachment.mimeType,
    fileName: attachment.filename,
    sizeBytes: attachment.sizeBytes,
  };
}
