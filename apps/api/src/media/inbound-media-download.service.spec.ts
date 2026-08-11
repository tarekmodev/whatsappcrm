import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { MESSAGE_ATTACHMENT_SETTLED_EVENT } from '../events/domain-events';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import {
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from '../whatsapp/meta-cloud-api.errors';
import { WhatsAppCredentialMissingError } from '../whatsapp/whatsapp.errors';
import type { WhatsAppMediaService } from '../whatsapp/whatsapp-media.service';
import { InboundMediaDownloadService } from './inbound-media-download.service';
import type { DownloadInboundMediaJob } from './media-jobs';

/**
 * The download job, which is where the interesting decisions are: what is
 * retried, what is parked, and what happens twice safely.
 *
 * Meta and the object store are substituted; the row transitions are asserted
 * against the arguments the service actually sends, because "guarded on
 * `pending`" is a property of the WHERE clause and not of a comment.
 */

const MAX_ATTEMPTS = 3;
const TENANT = '70444444-4444-7444-8444-444444444401';
const ATTACHMENT = '70444444-4444-7444-8444-4444444444e1';
const MESSAGE = '70444444-4444-7444-8444-4444444444d1';
const CONVERSATION = '70444444-4444-7444-8444-4444444444c1';
const MEDIA_OBJECT = '70444444-4444-7444-8444-4444444444f1';
const PROVIDER_MEDIA_ID = 'meta-media-1234';

const BYTES = Buffer.from('a photograph, notionally');
const DIGEST = createHash('sha256').update(BYTES).digest('hex');

const JOB: DownloadInboundMediaJob = {
  tenantId: TENANT,
  messageAttachmentId: ATTACHMENT,
  whatsappAccountId: '70444444-4444-7444-8444-4444444444b1',
};

const PENDING_ATTACHMENT = {
  id: ATTACHMENT,
  messageId: MESSAGE,
  kind: 'image' as const,
  mimeType: 'application/octet-stream',
  fileName: null,
  downloadState: 'pending' as const,
  providerMediaId: PROVIDER_MEDIA_ID,
  message: { conversationId: CONVERSATION },
};

const CONFIG = {
  getOrThrow: () => MAX_ATTEMPTS,
} as unknown as ConfigService;

describe('InboundMediaDownloadService', () => {
  let findUnique: jest.Mock;
  let updateMany: jest.Mock;
  let createMedia: jest.Mock;
  let transactionUpdateMany: jest.Mock;
  let putStream: jest.Mock;
  let deleteObject: jest.Mock;
  let downloadInbound: jest.Mock;
  let emit: jest.Mock;
  let service: InboundMediaDownloadService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(PENDING_ATTACHMENT);
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    createMedia = jest.fn().mockResolvedValue({ id: MEDIA_OBJECT });
    transactionUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

    const prisma = {
      messageAttachment: { findUnique, updateMany },
      $tenantTransaction: async (work: (tx: unknown) => Promise<unknown>) =>
        await work({
          mediaObject: { create: createMedia },
          messageAttachment: { updateMany: transactionUpdateMany },
        }),
    } as unknown as TenantPrisma;

    putStream = jest.fn().mockResolvedValue({ sizeBytes: BYTES.length, checksumSha256: DIGEST });
    deleteObject = jest.fn().mockResolvedValue(undefined);

    downloadInbound = jest.fn().mockResolvedValue({
      descriptor: {
        url: 'https://x.fbcdn.net/m',
        mimeType: 'image/jpeg',
        sizeBytes: null,
        sha256: null,
      },
      body: Readable.from(BYTES),
    });

    emit = jest.fn();

    service = new InboundMediaDownloadService(
      CONFIG,
      prisma,
      { putStream, getStream: jest.fn(), delete: deleteObject },
      { downloadInbound, uploadOutbound: jest.fn() } as unknown as WhatsAppMediaService,
      { emit } as unknown as EventEmitter2,
    );
  });

  /** The key and the cap the storage adapter was called with. */
  function storedWith(): { key: string; maxBytes: number } {
    const [call] = putStream.mock.calls as [string, unknown, number][];

    if (call === undefined) {
      throw new Error('nothing was written to storage');
    }

    return { key: call[0], maxBytes: call[2] };
  }

  /** The `data` the attachment was parked with. */
  function parkedWith(): { downloadState: string; downloadError: string } {
    const [call] = updateMany.mock.calls as [
      { data: { downloadState: string; downloadError: string } },
    ][];

    if (call === undefined) {
      throw new Error('the attachment was not parked');
    }

    return call[0].data;
  }

  /** The `data` the media-object insert was built from. */
  function insertedMedia(): Record<string, unknown> {
    const [call] = createMedia.mock.calls as [{ data: Record<string, unknown> }][];

    if (call === undefined) {
      throw new Error('no media object was inserted');
    }

    return call[0].data;
  }

  it('stores the bytes and points the attachment at them', async () => {
    await service.download(JOB, 1);

    const { key } = storedWith();

    expect(key).toMatch(new RegExp(`^tenants/${TENANT}/image/`));
    expect(createMedia).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        kind: 'image',
        source: 'inbound',
        storageKey: key,
        mimeType: 'image/jpeg',
        sizeBytes: BYTES.length,
        checksumSha256: DIGEST,
        fileName: null,
        providerMediaId: PROVIDER_MEDIA_ID,
      },
      select: { id: true },
    });
    expect(transactionUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: ATTACHMENT, downloadState: 'pending' },
      data: {
        mediaObjectId: MEDIA_OBJECT,
        url: `/api/v1/media/${MEDIA_OBJECT}/content`,
        mimeType: 'image/jpeg',
        sizeBytes: BYTES.length,
        downloadState: 'stored',
        downloadError: null,
      },
    });
  });

  it("prefers the media endpoint's media type over the one recorded at ingest", async () => {
    // The webhook payload sometimes omits `mime_type`; the media endpoint is
    // authoritative about the object it is serving.
    await service.download(JOB, 1);

    expect(insertedMedia().mimeType).toBe('image/jpeg');
  });

  it('falls back to the ingest media type when Meta names none', async () => {
    downloadInbound.mockResolvedValueOnce({
      descriptor: { url: 'https://x.fbcdn.net/m', mimeType: null, sizeBytes: null, sha256: null },
      body: Readable.from(BYTES),
    });

    await service.download(JOB, 1);

    expect(insertedMedia().mimeType).toBe('application/octet-stream');
  });

  it('announces that the attachment settled, so the inbox can stop waiting', async () => {
    await service.download(JOB, 1);

    expect(emit).toHaveBeenCalledWith(MESSAGE_ATTACHMENT_SETTLED_EVENT, {
      tenantId: TENANT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      attachmentId: ATTACHMENT,
      downloadState: 'stored',
      url: `/api/v1/media/${MEDIA_OBJECT}/content`,
      mimeType: 'image/jpeg',
      sizeBytes: BYTES.length,
    });
  });

  it('does nothing at all for an attachment that is no longer pending', async () => {
    findUnique.mockResolvedValueOnce({ ...PENDING_ATTACHMENT, downloadState: 'stored' });

    await service.download(JOB, 1);

    expect(downloadInbound).not.toHaveBeenCalled();
    expect(putStream).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('does nothing for an attachment that no longer exists', async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(service.download(JOB, 1)).resolves.toBeUndefined();
    expect(downloadInbound).not.toHaveBeenCalled();
  });

  it('parks an attachment that names no media handle', async () => {
    findUnique.mockResolvedValueOnce({ ...PENDING_ATTACHMENT, providerMediaId: null });

    await service.download(JOB, 1);

    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: ATTACHMENT, downloadState: 'pending' },
      data: { downloadState: 'failed', downloadError: 'the inbound payload named no media handle' },
    });
  });

  it('discards bytes whose digest does not match what Meta published', async () => {
    downloadInbound.mockResolvedValueOnce({
      descriptor: {
        url: 'https://x.fbcdn.net/m',
        mimeType: 'image/jpeg',
        sizeBytes: null,
        sha256: 'a'.repeat(64),
      },
      body: Readable.from(BYTES),
    });

    // Transient by classification — a truncated transfer is worth one more go —
    // so the first attempt rethrows for the queue to back off on.
    await expect(service.download(JOB, 1)).rejects.toThrow(/checksum did not match/);

    expect(deleteObject).toHaveBeenCalledWith(storedWith().key);
    expect(createMedia).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  describe('failure handling', () => {
    it.each([
      ['throttling', new MetaRateLimitedError(429, null, 30)],
      ['an unavailable Meta', new MetaUnavailableError(503, null, 'HTTP 503')],
      ['an unexpected fault', new Error('a socket hung up')],
    ])('retries %s while attempts remain', async (_name, error: Error) => {
      downloadInbound.mockRejectedValueOnce(error);

      await expect(service.download(JOB, 1)).rejects.toThrow(error);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['an expired handle', new MetaRequestRejectedError(404, null)],
      ['a missing credential', new WhatsAppCredentialMissingError('1022901')],
    ])('parks %s on the first attempt', async (_name, error: Error) => {
      downloadInbound.mockRejectedValueOnce(error);

      await service.download(JOB, 1);

      expect(parkedWith().downloadState).toBe('failed');
    });

    it('parks a transient failure once the attempts are spent', async () => {
      downloadInbound.mockRejectedValue(new MetaUnavailableError(503, null, 'HTTP 503'));

      await service.download(JOB, MAX_ATTEMPTS);

      const parked = parkedWith();

      expect(parked.downloadState).toBe('failed');
      // The reason is recorded for the operator, and names the class rather
      // than a URL or a token.
      expect(parked.downloadError).toContain('MetaUnavailableError');
    });

    it('announces a parked attachment too, so the spinner stops', async () => {
      downloadInbound.mockRejectedValueOnce(new MetaRequestRejectedError(404, null));

      await service.download(JOB, 1);

      expect(emit).toHaveBeenCalledWith(
        MESSAGE_ATTACHMENT_SETTLED_EVENT,
        expect.objectContaining({ downloadState: 'failed', url: null, sizeBytes: null }),
      );
    });

    it('announces nothing when another worker already settled the row', async () => {
      updateMany.mockResolvedValueOnce({ count: 0 });
      downloadInbound.mockRejectedValueOnce(new MetaRequestRejectedError(404, null));

      await service.download(JOB, 1);

      expect(emit).not.toHaveBeenCalled();
    });

    it('lets a deactivated tenant fail the job rather than parking a row it cannot write', async () => {
      const deactivated = new TenantNotActiveError(TENANT, 'findUnique', 'MessageAttachment');

      downloadInbound.mockRejectedValueOnce(deactivated);

      await expect(service.download(JOB, MAX_ATTEMPTS)).rejects.toThrow(deactivated);
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  it('discards its own media object when it loses the race to settle the row', async () => {
    transactionUpdateMany.mockResolvedValueOnce({ count: 0 });

    await service.download(JOB, 1);

    expect(deleteObject).toHaveBeenCalledWith(storedWith().key);
    expect(emit).not.toHaveBeenCalled();
  });

  it("caps the transfer at the ceiling for the attachment's kind", async () => {
    await service.download(JOB, 1);

    expect(storedWith().maxBytes).toBe(5 * 1_024 * 1_024);
  });
});
