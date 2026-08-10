import type { MetaCloudApiClient } from './meta-cloud-api.client';
import type { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';
import { WhatsAppSenderService } from './whatsapp-sender.service';

/**
 * The join between "which number is this" and "what does Meta need": that the
 * caller never supplies a credential, and that one send resolves one.
 */

const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';
const PHONE_NUMBER_ID = '15550001111';
const ACCESS_TOKEN = 'a-meta-access-token';
const RECIPIENT = '+966501234567';
const SENT = { providerMessageId: 'wamid.HBgL' };

describe('WhatsAppSenderService', () => {
  let forPhoneNumber: jest.Mock;
  let cloudApi: { sendText: jest.Mock; sendMedia: jest.Mock; sendTemplate: jest.Mock };
  let service: WhatsAppSenderService;

  beforeEach(() => {
    forPhoneNumber = jest.fn().mockResolvedValue({
      whatsappAccountId: ACCOUNT_ROW_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      whatsappBusinessAccountId: '60444444-4444-7444-8444-444444444401',
      wabaId: '102290129340398',
      accessToken: ACCESS_TOKEN,
    });

    cloudApi = {
      sendText: jest.fn().mockResolvedValue(SENT),
      sendMedia: jest.fn().mockResolvedValue(SENT),
      sendTemplate: jest.fn().mockResolvedValue(SENT),
    };

    service = new WhatsAppSenderService(
      { forPhoneNumber } as unknown as WhatsAppCredentialResolver,
      cloudApi as unknown as MetaCloudApiClient,
    );
  });

  it('resolves the number’s own credential and sends text with it', async () => {
    await expect(
      service.sendText({ whatsappAccountId: ACCOUNT_ROW_ID, to: RECIPIENT, body: 'hello' }),
    ).resolves.toEqual(SENT);

    expect(forPhoneNumber).toHaveBeenCalledWith(ACCOUNT_ROW_ID);
    expect(cloudApi.sendText).toHaveBeenCalledWith({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      to: RECIPIENT,
      body: 'hello',
      previewUrl: undefined,
    });
  });

  it('sends media on the same credential', async () => {
    await service.sendMedia({
      whatsappAccountId: ACCOUNT_ROW_ID,
      to: RECIPIENT,
      kind: 'image',
      media: { link: 'https://cdn.test/a.jpg' },
    });

    expect(cloudApi.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: PHONE_NUMBER_ID, accessToken: ACCESS_TOKEN }),
    );
  });

  it('names the template rather than looking it up, so Meta stays the authority', async () => {
    await service.sendTemplate({
      whatsappAccountId: ACCOUNT_ROW_ID,
      to: RECIPIENT,
      templateName: 'order_update',
      languageCode: 'en_US',
      variables: ['A-1001'],
    });

    expect(cloudApi.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'order_update', variables: ['A-1001'] }),
    );
  });

  it('does not retry a failed send — that belongs to the queue that owns the attempt count', async () => {
    const failure = new Error('Meta said no');
    cloudApi.sendText.mockRejectedValue(failure);

    await expect(
      service.sendText({ whatsappAccountId: ACCOUNT_ROW_ID, to: RECIPIENT, body: 'hello' }),
    ).rejects.toBe(failure);
    expect(cloudApi.sendText).toHaveBeenCalledTimes(1);
  });
});
