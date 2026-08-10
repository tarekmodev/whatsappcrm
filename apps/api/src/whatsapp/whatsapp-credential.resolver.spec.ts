import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { WhatsAppAccessTokenCipher } from './access-token.cipher';
import { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';
import {
  WhatsAppAccountNotFoundError,
  WhatsAppBusinessAccountNotFoundError,
  WhatsAppCredentialMissingError,
} from './whatsapp.errors';

/**
 * The one place a stored token is decrypted. The assertions worth having are
 * about what it refuses and what it binds the decryption to — a resolver that
 * decrypted with the wrong AAD would work perfectly until someone moved a row.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';
const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '15550001111';
const ENCRYPTED = 'v1.aaa.bbb.ccc';
const ACCESS_TOKEN = 'a-meta-access-token';

const WABA_ROW = { id: WABA_ROW_ID, wabaId: WABA_ID, accessTokenEncrypted: ENCRYPTED };

describe('WhatsAppCredentialResolver', () => {
  let wabaFindUnique: jest.Mock;
  let accountFindUnique: jest.Mock;
  let decrypt: jest.Mock;
  let resolver: WhatsAppCredentialResolver;

  beforeEach(() => {
    wabaFindUnique = jest.fn().mockResolvedValue(WABA_ROW);
    accountFindUnique = jest.fn().mockResolvedValue({
      id: ACCOUNT_ROW_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      whatsappBusinessAccount: WABA_ROW,
    });
    decrypt = jest.fn().mockReturnValue(ACCESS_TOKEN);

    resolver = new WhatsAppCredentialResolver(
      {
        whatsappBusinessAccount: { findUnique: wabaFindUnique },
        whatsappAccount: { findUnique: accountFindUnique },
      } as unknown as TenantPrisma,
      { decrypt } as unknown as WhatsAppAccessTokenCipher,
    );
  });

  it('decrypts with the WABA id as the binding, so a moved row fails', async () => {
    await resolver.forBusinessAccount(WABA_ROW_ID);

    expect(decrypt).toHaveBeenCalledWith(ENCRYPTED, WABA_ID);
  });

  it('reads only the three credential columns, never a wider projection', async () => {
    await resolver.forBusinessAccount(WABA_ROW_ID);

    const [call] = wabaFindUnique.mock.calls as [{ select: Record<string, boolean> }][];

    expect(Object.keys(call?.[0].select ?? {}).sort()).toEqual([
      'accessTokenEncrypted',
      'id',
      'wabaId',
    ]);
  });

  it('resolves a phone number and its parent’s token in one query', async () => {
    const credentials = await resolver.forPhoneNumber(ACCOUNT_ROW_ID);

    expect(accountFindUnique).toHaveBeenCalledTimes(1);
    expect(wabaFindUnique).not.toHaveBeenCalled();
    expect(credentials).toEqual({
      whatsappAccountId: ACCOUNT_ROW_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      whatsappBusinessAccountId: WABA_ROW_ID,
      wabaId: WABA_ID,
      accessToken: ACCESS_TOKEN,
    });
  });

  it('reports another tenant’s WABA as absent, not as forbidden', async () => {
    // RLS makes the two indistinguishable, and TAR-39 requires they stay that
    // way: a 403 would confirm the id exists.
    wabaFindUnique.mockResolvedValue(null);

    await expect(resolver.forBusinessAccountByWabaId(WABA_ID)).rejects.toBeInstanceOf(
      WhatsAppBusinessAccountNotFoundError,
    );
  });

  it('reports an unknown phone number as absent', async () => {
    accountFindUnique.mockResolvedValue(null);

    await expect(resolver.forPhoneNumber(ACCOUNT_ROW_ID)).rejects.toBeInstanceOf(
      WhatsAppAccountNotFoundError,
    );
  });

  it('distinguishes a WABA that was never given a token from one that will not decrypt', async () => {
    wabaFindUnique.mockResolvedValue({ ...WABA_ROW, accessTokenEncrypted: null });

    await expect(resolver.forBusinessAccount(WABA_ROW_ID)).rejects.toBeInstanceOf(
      WhatsAppCredentialMissingError,
    );
    expect(decrypt).not.toHaveBeenCalled();
  });
});
