import { Readable } from 'node:stream';
import type { WhatsAppMediaService } from '../whatsapp/whatsapp-media.service';
import { MediaNotFoundError } from './media.errors';
import type { MediaReaderService } from './media-reader.service';
import { MediaSendResolver } from './media-send.resolver';

const MEDIA_ID = '70444444-4444-7444-8444-4444444444f1';
const ACCOUNT_ID = '70444444-4444-7444-8444-4444444444b1';

const MEDIA = {
  id: MEDIA_ID,
  kind: 'document' as const,
  source: 'upload' as const,
  mimeType: 'application/pdf',
  sizeBytes: 5,
  fileName: 'invoice.pdf',
  createdAt: new Date('2026-08-11T09:00:00.000Z'),
};

describe('MediaSendResolver', () => {
  let read: jest.Mock;
  let uploadOutbound: jest.Mock;
  let resolver: MediaSendResolver;

  beforeEach(() => {
    read = jest.fn().mockResolvedValue({ media: MEDIA, body: Readable.from(Buffer.from('%PDF-')) });
    uploadOutbound = jest.fn().mockResolvedValue('meta-media-out');

    resolver = new MediaSendResolver(
      { read } as unknown as MediaReaderService,
      { uploadOutbound } as unknown as WhatsAppMediaService,
    );
  });

  interface UploadCommand {
    readonly whatsappAccountId: string;
    readonly file: Blob;
    readonly mimeType: string;
    readonly fileName: string;
  }

  /** The command the WhatsApp media service was asked to upload. */
  function uploadCommand(): UploadCommand {
    const [call] = uploadOutbound.mock.calls as [UploadCommand][];

    if (call === undefined) {
      throw new Error('nothing was uploaded');
    }

    return call[0];
  }

  it('uploads the stored bytes and answers with Meta’s handle', async () => {
    await expect(resolver.resolveForSend(MEDIA_ID, ACCOUNT_ID)).resolves.toEqual({
      mediaId: 'meta-media-out',
    });

    const command = uploadCommand();

    expect(command.whatsappAccountId).toBe(ACCOUNT_ID);
    expect(command.mimeType).toBe('application/pdf');
    expect(command.fileName).toBe('invoice.pdf');
    await expect(command.file.text()).resolves.toBe('%PDF-');
  });

  it('names the part after the row when the object has no file name', async () => {
    // Meta rejects an empty part name, and an audio note legitimately has none.
    read.mockResolvedValueOnce({
      media: { ...MEDIA, fileName: null },
      body: Readable.from(Buffer.from('x')),
    });

    await resolver.resolveForSend(MEDIA_ID, ACCOUNT_ID);

    expect(uploadCommand().fileName).toBe(MEDIA_ID);
  });

  it('never reaches Meta for an id the tenant does not own', async () => {
    // The reader is the tenant boundary: another tenant's id is `not found`,
    // and this must not turn into an upload of somebody else's file.
    read.mockRejectedValueOnce(new MediaNotFoundError(MEDIA_ID));

    await expect(resolver.resolveForSend(MEDIA_ID, ACCOUNT_ID)).rejects.toThrow(MediaNotFoundError);
    expect(uploadOutbound).not.toHaveBeenCalled();
  });

  it('uploads per call rather than caching Meta’s handle', async () => {
    // The handle is scoped to one phone number and expires on Meta's schedule;
    // a cached one fails a send that a fresh upload would have delivered.
    await resolver.resolveForSend(MEDIA_ID, ACCOUNT_ID);
    await resolver.resolveForSend(MEDIA_ID, ACCOUNT_ID);

    expect(uploadOutbound).toHaveBeenCalledTimes(2);
  });
});
