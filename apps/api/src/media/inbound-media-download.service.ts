import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WHATSAPP_MEDIA_LIMITS, mediaContentPath } from '@whatsappcrm/contracts';
import {
  MESSAGE_ATTACHMENT_SETTLED_EVENT,
  type MessageAttachmentSettledEvent,
} from '../events/domain-events';
import { MediaDownloadState, MediaSource } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import {
  MetaCloudApiError,
  MetaRateLimitedError,
  MetaUnavailableError,
} from '../whatsapp/meta-cloud-api.errors';
import { WhatsAppError } from '../whatsapp/whatsapp.errors';
import { WhatsAppMediaService } from '../whatsapp/whatsapp-media.service';
import { MediaError } from './media.errors';
import { mediaObjectKey } from './media-object-key';
import type { DownloadInboundMediaJob } from './media-jobs';
import { MEDIA_STORAGE, type MediaStorage } from './storage/media-storage.port';

/** Everything the job needs from the attachment row it was queued for. */
const ATTACHMENT_PROJECTION = {
  id: true,
  messageId: true,
  kind: true,
  mimeType: true,
  fileName: true,
  downloadState: true,
  providerMediaId: true,
  message: { select: { conversationId: true } },
} as const;

/**
 * Fetches the bytes of one inbound attachment from Meta and re-hosts them.
 *
 * ## Why this is a job and not part of ingestion
 *
 * Meta's webhook has to be answered promptly or it is retried, and a media
 * download is two more network calls and up to 100 MB of transfer. Doing it
 * inline would put the whole inbox behind the slowest customer's video.
 *
 * So `WhatsAppInboundWriter` records the attachment `pending` in the same
 * transaction as the message — the durable statement of "bytes are owed" — and
 * queues this. The message reaches the agent immediately; the picture follows.
 *
 * ## Racing Meta's five-minute window
 *
 * A media URL is valid for five minutes from the moment `describeMedia` issues
 * it. That is the constraint that shapes the retry policy: the budget is small
 * (`MEDIA_DOWNLOAD_MAX_ATTEMPTS`, three by default), because past the window no
 * attempt can succeed and spending twenty of them only keeps a spinner turning.
 *
 * A permanent refusal — an expired handle, a credential that no longer works, a
 * file over the limit — parks the attachment `failed` on the first attempt
 * rather than burning the budget on an answer that will not change.
 *
 * ## Idempotency
 *
 * The first thing the job reads is `download_state`. Anything but `pending` is
 * a no-op, so a webhook replay, a re-enqueue and a worker whose lock expired
 * mid-transfer all cost one SELECT rather than a duplicate object. The stray
 * bytes a crashed transfer left behind are unreferenced and swept; they are
 * never mistaken for the real thing, because the row is what says where the
 * real thing is.
 */
@Injectable()
export class InboundMediaDownloadService {
  private readonly logger = new Logger(InboundMediaDownloadService.name);
  private readonly maxAttempts: number;

  constructor(
    config: ConfigService,
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    private readonly whatsappMedia: WhatsAppMediaService,
    private readonly events: EventEmitter2,
  ) {
    this.maxAttempts = config.getOrThrow<number>('MEDIA_DOWNLOAD_MAX_ATTEMPTS');
  }

  /**
   * Runs one attempt.
   *
   * `attempt` is BullMQ's count for this job, one-based. It decides only what
   * happens to a *transient* failure: below the budget it is rethrown so the
   * queue backs off and tries again, and at the budget the attachment is parked
   * so the inbox stops waiting.
   */
  async download(job: DownloadInboundMediaJob, attempt: number): Promise<void> {
    const attachment = await this.prisma.messageAttachment.findUnique({
      where: { id: job.messageAttachmentId },
      select: ATTACHMENT_PROJECTION,
    });

    if (attachment === null) {
      // The message was deleted, or the job outlived a rollback. Nothing owed.
      return;
    }

    if (attachment.downloadState !== MediaDownloadState.pending) {
      return;
    }

    if (attachment.providerMediaId === null) {
      await this.park(job, attachment, 'the inbound payload named no media handle');
      return;
    }

    try {
      await this.store(job, { ...attachment, providerMediaId: attachment.providerMediaId });
    } catch (error: unknown) {
      await this.handleFailure(job, attachment, error, attempt);
    }
  }

  /**
   * Downloads, verifies and records, in that order.
   *
   * The media object row and the attachment update are one transaction: an
   * attachment pointing at a media object that does not exist would break every
   * later read of that thread, and the two writes are cheap enough that there
   * is no reason to risk it.
   */
  private async store(job: DownloadInboundMediaJob, attachment: PendingAttachment): Promise<void> {
    const { descriptor, body } = await this.whatsappMedia.downloadInbound({
      whatsappAccountId: job.whatsappAccountId,
      providerMediaId: attachment.providerMediaId,
    });

    // Meta's type wins over the one recorded at ingest when it has one: the
    // ingest payload sometimes omits `mime_type`, and the media endpoint is the
    // authoritative answer for the object it is about to serve.
    const mimeType = descriptor.mimeType ?? attachment.mimeType;
    const maxBytes = WHATSAPP_MEDIA_LIMITS[attachment.kind].maxBytes;
    const key = mediaObjectKey(job.tenantId, attachment.kind, randomUUID());

    const written = await this.storage.putStream(key, body, maxBytes);

    if (descriptor.sha256 !== null && descriptor.sha256 !== written.checksumSha256) {
      // A truncated or corrupted transfer. The bytes are removed rather than
      // stored: a file that does not match the digest Meta published is not the
      // customer's file, and serving it to an agent as if it were is worse than
      // showing a failure.
      await this.discard(key);
      throw new MetaUnavailableError(0, null, 'media checksum did not match');
    }

    const settled = await this.prisma.$tenantTransaction(async (tx) => {
      const media = await tx.mediaObject.create({
        data: {
          tenantId: job.tenantId,
          kind: attachment.kind,
          source: MediaSource.inbound,
          storageKey: key,
          mimeType,
          sizeBytes: written.sizeBytes,
          checksumSha256: written.checksumSha256,
          fileName: attachment.fileName,
          providerMediaId: attachment.providerMediaId,
        },
        select: { id: true },
      });

      const url = mediaContentPath(media.id);

      // Guarded on `pending` so a second worker that got this far concurrently
      // updates nothing, and reports it: the check and the write are one
      // statement rather than a read-modify-write two workers can interleave.
      const { count } = await tx.messageAttachment.updateMany({
        where: {
          tenantId: job.tenantId,
          id: attachment.id,
          downloadState: MediaDownloadState.pending,
        },
        data: {
          mediaObjectId: media.id,
          url,
          mimeType,
          sizeBytes: written.sizeBytes,
          downloadState: MediaDownloadState.stored,
          downloadError: null,
        },
      });

      return count === 0 ? null : { mediaId: media.id, url, sizeBytes: written.sizeBytes };
    });

    if (settled === null) {
      // Lost the race. The media object created above is now unreferenced, so
      // its bytes go with it; the winner's copy is the one the attachment
      // names. Rare enough to be worth the extra delete rather than a lock.
      await this.discard(key);
      return;
    }

    this.emitSettled(job, attachment, {
      downloadState: MediaDownloadState.stored,
      url: settled.url,
      mimeType,
      sizeBytes: settled.sizeBytes,
    });
  }

  /**
   * Decides whether a failure is worth another attempt, and parks the
   * attachment when it is not.
   *
   * The classification is the point. A rate limit or an unavailable Meta is
   * worth waiting for; an expired handle, a rejected request or a file over the
   * limit is not, and retrying those spends the whole budget to arrive at the
   * same answer several minutes later — with the inbox showing a spinner
   * throughout.
   *
   * `TenantNotActiveError` is rethrown untouched: the tenant was deactivated
   * mid-flight (TAR-51), so there is no row to park and no scope to write in.
   * The job fails, and if the tenant returns the attachment is still `pending`.
   */
  private async handleFailure(
    job: DownloadInboundMediaJob,
    attachment: AttachmentRow,
    error: unknown,
    attempt: number,
  ): Promise<void> {
    if (error instanceof TenantNotActiveError) {
      throw error;
    }

    const detail = describe(error);

    if (isRetriable(error) && attempt < this.maxAttempts) {
      this.logger.warn(
        `Inbound media download for attachment ${attachment.id} failed on attempt ` +
          `${attempt}/${this.maxAttempts}, retrying: ${detail}`,
      );
      // Rethrown so BullMQ applies its backoff. The row stays `pending`, which
      // is exactly the state the next attempt expects.
      throw error;
    }

    await this.park(job, attachment, detail);
  }

  /**
   * Records that this attachment will never have bytes, with the reason.
   *
   * The attachment row survives, deliberately. The customer did send a file;
   * removing the row would show the agent a message with nothing attached and
   * no indication that anything was missing.
   */
  private async park(
    job: DownloadInboundMediaJob,
    attachment: AttachmentRow,
    reason: string,
  ): Promise<void> {
    const { count } = await this.prisma.messageAttachment.updateMany({
      where: {
        tenantId: job.tenantId,
        id: attachment.id,
        downloadState: MediaDownloadState.pending,
      },
      data: { downloadState: MediaDownloadState.failed, downloadError: reason },
    });

    this.logger.error(`Inbound media for attachment ${attachment.id} parked as failed: ${reason}`);

    if (count > 0) {
      this.emitSettled(job, attachment, {
        downloadState: MediaDownloadState.failed,
        url: null,
        mimeType: attachment.mimeType,
        sizeBytes: null,
      });
    }
  }

  private emitSettled(
    job: DownloadInboundMediaJob,
    attachment: AttachmentRow,
    outcome: Pick<
      MessageAttachmentSettledEvent,
      'downloadState' | 'url' | 'mimeType' | 'sizeBytes'
    >,
  ): void {
    this.events.emit(MESSAGE_ATTACHMENT_SETTLED_EVENT, {
      tenantId: job.tenantId,
      conversationId: attachment.message.conversationId,
      messageId: attachment.messageId,
      attachmentId: attachment.id,
      ...outcome,
    } satisfies MessageAttachmentSettledEvent);
  }

  /** Best-effort removal of bytes nothing references. Never masks the real failure. */
  private async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch((error: unknown) => {
      this.logger.warn(`Could not remove unreferenced media bytes: ${describe(error)}`);
    });
  }
}

type AttachmentRow = {
  readonly id: string;
  readonly messageId: string;
  readonly kind: keyof typeof WHATSAPP_MEDIA_LIMITS;
  readonly mimeType: string;
  readonly fileName: string | null;
  readonly providerMediaId: string | null;
  readonly message: { readonly conversationId: string };
};

type PendingAttachment = AttachmentRow & { readonly providerMediaId: string };

/**
 * Whether another attempt could plausibly succeed.
 *
 * Ordered from most specific to least, and the default at the bottom is
 * "retry": an error no branch recognises is a bug or an outage, and both are
 * worth one more try inside a budget of three.
 *
 *   * throttled or unavailable — Meta will answer differently later;
 *   * any other Meta error — authentication, a rejection, an expired handle —
 *     is an answer that will not change within the five minutes the URL is
 *     valid for;
 *   * any media error — over the limit, unsupported — is about the file, and
 *     the file will be identical next time.
 */
function isRetriable(error: unknown): boolean {
  if (error instanceof MetaRateLimitedError || error instanceof MetaUnavailableError) {
    return true;
  }

  return !(
    error instanceof MetaCloudApiError ||
    error instanceof WhatsAppError ||
    error instanceof MediaError
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
