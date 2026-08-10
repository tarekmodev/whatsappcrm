import type { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { WhatsAppAccessTokenCipher } from './access-token.cipher';
import {
  WHATSAPP_BUSINESS_ACCOUNT_CONNECTED_ACTION,
  WhatsAppBusinessAccountConnectionService,
  type ConnectBusinessAccountCommand,
} from './business-account-connection.service';
import { WhatsAppIdentityTakenError } from './whatsapp.errors';

/**
 * What the service composes, with no database in the way: which statements it
 * issues, what it refuses to overwrite, and — the one that matters most — that
 * the plaintext access token never reaches a row or an audit entry.
 */

const TENANT_ID = '50444444-4444-7444-8444-444444444401';
const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const OTHER_WABA_ROW_ID = '60444444-4444-7444-8444-4444444444ff';
const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';
const WABA_ID = '102290129340398';
const ACCESS_TOKEN = 'a-meta-access-token';
const ENCRYPTED = 'v1.aaa.bbb.ccc';
const TIMESTAMP = new Date('2026-08-10T09:00:00.000Z');

const COMMAND: ConnectBusinessAccountCommand = {
  wabaId: WABA_ID,
  name: 'Acme Ltd',
  accessToken: ACCESS_TOKEN,
  phoneNumbers: [{ phoneNumberId: '15550001111', displayPhoneNumber: '+15550001111' }],
};

const WABA_ROW = {
  id: WABA_ROW_ID,
  wabaId: WABA_ID,
  name: 'Acme Ltd',
  verificationStatus: 'not_verified',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const ACCOUNT_ROW = {
  id: ACCOUNT_ROW_ID,
  whatsappBusinessAccountId: WABA_ROW_ID,
  phoneNumberId: '15550001111',
  displayPhoneNumber: '+15550001111',
  verifiedName: null,
  qualityRating: null,
  status: 'connected',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

interface TransactionSpies {
  $executeRaw: jest.Mock;
  whatsappBusinessAccount: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  whatsappAccount: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  auditLog: { create: jest.Mock };
}

/** Only the fields these assertions read. */
interface WriteArgs {
  data: Record<string, unknown>;
}

describe('WhatsAppBusinessAccountConnectionService', () => {
  let tx: TransactionSpies;
  let cipher: { encrypt: jest.Mock };
  let service: WhatsAppBusinessAccountConnectionService;

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      whatsappBusinessAccount: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(WABA_ROW),
        update: jest.fn().mockResolvedValue(WABA_ROW),
      },
      whatsappAccount: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(ACCOUNT_ROW),
        update: jest.fn().mockResolvedValue(ACCOUNT_ROW),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
    };

    const prisma = {
      $tenantTransaction: jest.fn(async (work: (client: TransactionSpies) => Promise<unknown>) =>
        work(tx),
      ),
    } as unknown as TenantPrisma;

    cipher = { encrypt: jest.fn().mockReturnValue(ENCRYPTED) };

    service = new WhatsAppBusinessAccountConnectionService(
      prisma,
      { requireTenantId: () => TENANT_ID } as unknown as TenantContextService,
      cipher as unknown as WhatsAppAccessTokenCipher,
    );
  });

  function firstCallArgs(spy: jest.Mock): WriteArgs {
    const [call] = spy.mock.calls as [WriteArgs][];

    if (call === undefined) {
      throw new Error('the spy was never called');
    }

    return call[0];
  }

  describe('a WABA that has never been connected', () => {
    it('creates it, attaches the number, and reports that it created it', async () => {
      const result = await service.connect(COMMAND);

      expect(result.created).toBe(true);
      expect(tx.whatsappBusinessAccount.create).toHaveBeenCalledTimes(1);
      expect(tx.whatsappAccount.create).toHaveBeenCalledTimes(1);
      expect(result.businessAccount.accounts).toHaveLength(1);
    });

    it('serialises concurrent connections of the same WABA behind an advisory lock', async () => {
      await service.connect(COMMAND);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('stores the token encrypted, bound to the WABA it belongs to', async () => {
      await service.connect(COMMAND);

      expect(cipher.encrypt).toHaveBeenCalledWith(ACCESS_TOKEN, WABA_ID);
      expect(firstCallArgs(tx.whatsappBusinessAccount.create).data).toMatchObject({
        accessTokenEncrypted: ENCRYPTED,
      });
    });

    it('never writes the plaintext token to any row', async () => {
      await service.connect(COMMAND);

      const written = JSON.stringify([
        tx.whatsappBusinessAccount.create.mock.calls,
        tx.whatsappAccount.create.mock.calls,
        tx.auditLog.create.mock.calls,
      ]);

      expect(written).not.toContain(ACCESS_TOKEN);
    });

    it('supplies tenant_id explicitly, because the scope extension injects nothing into data', async () => {
      await service.connect(COMMAND);

      expect(firstCallArgs(tx.whatsappBusinessAccount.create).data).toMatchObject({
        tenantId: TENANT_ID,
      });
      expect(firstCallArgs(tx.whatsappAccount.create).data).toMatchObject({ tenantId: TENANT_ID });
    });

    it('audits the connection with the ids, and nothing else', async () => {
      await service.connect(COMMAND);

      expect(firstCallArgs(tx.auditLog.create).data).toMatchObject({
        tenantId: TENANT_ID,
        actorUserId: null,
        action: WHATSAPP_BUSINESS_ACCOUNT_CONNECTED_ACTION,
        targetType: 'whatsapp_business_account',
        targetId: WABA_ROW_ID,
        metadata: { wabaId: WABA_ID, phoneNumberIds: ['15550001111'] },
      });
    });

    it('never returns the encrypted token either', async () => {
      const result = await service.connect(COMMAND);

      expect(result.businessAccount).not.toHaveProperty('accessTokenEncrypted');
    });
  });

  describe('a WABA that is already connected', () => {
    beforeEach(() => {
      tx.whatsappBusinessAccount.findUnique.mockResolvedValue({ id: WABA_ROW_ID });
    });

    it('updates it rather than creating a second row', async () => {
      const result = await service.connect(COMMAND);

      expect(result.created).toBe(false);
      expect(tx.whatsappBusinessAccount.create).not.toHaveBeenCalled();
      expect(tx.whatsappBusinessAccount.update).toHaveBeenCalledTimes(1);
    });

    it('re-encrypts the token, which is how rotation happens', async () => {
      await service.connect({ ...COMMAND, accessToken: 'a-rotated-token' });

      expect(cipher.encrypt).toHaveBeenCalledWith('a-rotated-token', WABA_ID);
      expect(firstCallArgs(tx.whatsappBusinessAccount.update).data).toMatchObject({
        accessTokenEncrypted: ENCRYPTED,
      });
    });

    it('leaves a name and a verification status the request did not mention', async () => {
      await service.connect({
        wabaId: WABA_ID,
        accessToken: ACCESS_TOKEN,
        phoneNumbers: COMMAND.phoneNumbers,
      });

      const { data } = firstCallArgs(tx.whatsappBusinessAccount.update);

      expect(data).not.toHaveProperty('name');
      expect(data).not.toHaveProperty('verificationStatus');
    });
  });

  describe('phone numbers', () => {
    it('moves a number that already belongs to another of this tenant’s WABAs', async () => {
      tx.whatsappAccount.findUnique.mockResolvedValue({ id: ACCOUNT_ROW_ID });
      tx.whatsappBusinessAccount.findUnique.mockResolvedValue({ id: OTHER_WABA_ROW_ID });
      tx.whatsappBusinessAccount.update.mockResolvedValue({ ...WABA_ROW, id: OTHER_WABA_ROW_ID });

      await service.connect(COMMAND);

      expect(firstCallArgs(tx.whatsappAccount.update).data).toMatchObject({
        whatsappBusinessAccountId: OTHER_WABA_ROW_ID,
        status: 'connected',
      });
    });

    it('never deletes a number that the request simply did not mention', async () => {
      await service.connect(COMMAND);

      expect(Object.keys(tx.whatsappAccount)).toEqual(['findUnique', 'create', 'update']);
    });

    it("does not reset Meta's quality rating when the request omits it", async () => {
      tx.whatsappAccount.findUnique.mockResolvedValue({ id: ACCOUNT_ROW_ID });

      await service.connect(COMMAND);

      expect(firstCallArgs(tx.whatsappAccount.update).data).not.toHaveProperty('qualityRating');
    });
  });

  describe('an id another tenant already holds', () => {
    /** What Prisma reports for a unique violation on the driver-adapter path. */
    function uniqueViolation(constraint: string): Prisma.PrismaClientKnownRequestError {
      return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: {
          driverAdapterError: {
            cause: {
              originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
            },
          },
        },
      });
    }

    it('reports a WABA collision as a conflict rather than a fault', async () => {
      // Under RLS the pre-read cannot see a neighbour's row, so the global unique
      // index is what catches this — and it has to be translated, not logged as a 500.
      tx.whatsappBusinessAccount.create.mockRejectedValue(
        uniqueViolation('whatsapp_business_accounts_waba_id_key'),
      );

      const error = await service.connect(COMMAND).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(WhatsAppIdentityTakenError);
      expect((error as WhatsAppIdentityTakenError).kind).toBe('waba');
    });

    it('reports a phone-number collision as a conflict', async () => {
      tx.whatsappAccount.create.mockRejectedValue(
        uniqueViolation('whatsapp_accounts_phone_number_id_key'),
      );

      const error = await service.connect(COMMAND).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(WhatsAppIdentityTakenError);
      expect((error as WhatsAppIdentityTakenError).kind).toBe('phone-number');
    });

    it('leaves anything else untranslated, so a fault is logged as one', async () => {
      const fault = new Error('connection terminated');
      tx.whatsappBusinessAccount.create.mockRejectedValue(fault);

      await expect(service.connect(COMMAND)).rejects.toBe(fault);
    });
  });
});
