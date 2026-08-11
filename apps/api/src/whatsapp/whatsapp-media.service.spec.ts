import type { ConfigService } from '@nestjs/config';
import { MetaCloudApiClient } from './meta-cloud-api.client';
import { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';
import { WhatsAppMediaService } from './whatsapp-media.service';

/**
 * The credential-resolving half of the media path.
 *
 * The property under test is the arrangement, not the transport: that the token
 * is resolved here and passed through, that a transfer gets the transfer
 * timeout rather than the Graph API's, and that the two inbound calls happen
 * back to back — Meta's URL is good for five minutes and anything between them
 * is spent against that.
 */

const ACCOUNT_ID = '70444444-4444-7444-8444-4444444444b1';
const PHONE_NUMBER_ID = '15550001111';
const ACCESS_TOKEN = 'a-meta-access-token';
const TRANSFER_TIMEOUT_MS = 60_000;

const CONFIG = {
  getOrThrow: () => TRANSFER_TIMEOUT_MS,
} as unknown as ConfigService;

describe('WhatsAppMediaService', () => {
  let forPhoneNumber: jest.Mock;
  let describeMedia: jest.Mock;
  let downloadMedia: jest.Mock;
  let uploadMedia: jest.Mock;
  let service: WhatsAppMediaService;

  beforeEach(() => {
    forPhoneNumber = jest.fn().mockResolvedValue({
      whatsappBusinessAccountId: 'waba-row',
      wabaId: '102290129340398',
      accessToken: ACCESS_TOKEN,
      whatsappAccountId: ACCOUNT_ID,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    describeMedia = jest.fn().mockResolvedValue({
      url: 'https://x.fbcdn.net/m',
      mimeType: 'image/jpeg',
      sha256: null,
      sizeBytes: null,
    });
    downloadMedia = jest.fn().mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('bytes'));
          controller.close();
        },
      }),
    );
    uploadMedia = jest.fn().mockResolvedValue('meta-media-out');

    service = new WhatsAppMediaService(
      CONFIG,
      { forPhoneNumber } as unknown as WhatsAppCredentialResolver,
      { describeMedia, downloadMedia, uploadMedia } as unknown as MetaCloudApiClient,
    );
  });

  describe('downloadInbound', () => {
    it('resolves the handle, then opens the transfer with the same token', async () => {
      const { descriptor } = await service.downloadInbound({
        whatsappAccountId: ACCOUNT_ID,
        providerMediaId: 'meta-media-in',
      });

      expect(forPhoneNumber).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(describeMedia).toHaveBeenCalledWith({
        providerMediaId: 'meta-media-in',
        accessToken: ACCESS_TOKEN,
      });
      expect(downloadMedia).toHaveBeenCalledWith({
        url: descriptor.url,
        accessToken: ACCESS_TOKEN,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
    });

    it('hands back a Node stream, so nothing has to buffer the object', async () => {
      const { body } = await service.downloadInbound({
        whatsappAccountId: ACCOUNT_ID,
        providerMediaId: 'meta-media-in',
      });

      const chunks: Buffer[] = [];

      for await (const chunk of body) {
        chunks.push(chunk as Buffer);
      }

      expect(Buffer.concat(chunks).toString()).toBe('bytes');
    });

    it('does not open a transfer when the handle cannot be resolved', async () => {
      describeMedia.mockRejectedValueOnce(new Error('gone'));

      await expect(
        service.downloadInbound({ whatsappAccountId: ACCOUNT_ID, providerMediaId: 'x' }),
      ).rejects.toThrow('gone');
      expect(downloadMedia).not.toHaveBeenCalled();
    });
  });

  describe('uploadOutbound', () => {
    it('uploads to the number the message will be sent from', async () => {
      const file = new Blob([new Uint8Array([1])], { type: 'application/pdf' });

      await expect(
        service.uploadOutbound({
          whatsappAccountId: ACCOUNT_ID,
          file,
          mimeType: 'application/pdf',
          fileName: 'invoice.pdf',
        }),
      ).resolves.toBe('meta-media-out');

      expect(uploadMedia).toHaveBeenCalledWith({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        file,
        mimeType: 'application/pdf',
        fileName: 'invoice.pdf',
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
    });
  });
});
