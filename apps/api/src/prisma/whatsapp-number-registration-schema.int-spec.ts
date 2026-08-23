import type { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { WhatsAppCredentialCipher } from '../whatsapp/whatsapp-credential.cipher';
import { WhatsAppTokenUndecryptableError } from '../whatsapp/whatsapp.errors';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * The registration columns on `whatsapp_accounts` (TAR-767), against a real
 * PostgreSQL.
 *
 * Three of the four things this migration promises cannot be shown by a unit
 * test, because all three are properties of the database rather than of any
 * TypeScript:
 *
 *   * **The default is `unregistered`.** Every row in this table predates
 *     registration, so `failed` would print a Meta rejection that never
 *     happened. What makes that true for rows already on disk is the column
 *     default recorded by `ADD COLUMN`, not anything the application does — and
 *     nothing else in the toolchain reads it back.
 *   * **The PIN round-trips through the access token's own cipher.** The
 *     acceptance criterion is explicitly "verified by a test, not just code
 *     inspection": the value has to survive a `text` column and come back out of
 *     `WhatsAppCredentialCipher.decrypt` byte for byte, with the leading zeros
 *     a `000042` PIN depends on.
 *   * **The new columns are inside tenant isolation.**
 *     `registration_pin_encrypted` is a credential of the same class as
 *     `access_token_encrypted`. `tenant_isolation` predicates on `tenant_id` and
 *     so covers new columns for free — which is a fine argument and not
 *     evidence, so the read is made as `whatsappcrm_app` and asserted.
 *
 * No service code exists yet (TAR-768 builds it), so the writes below are what
 * the registration service will do, made directly. That is the point: this
 * proves the *storage* is right before anything depends on it.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. One fixture tenant,
 * its WABA and two numbers, all carrying fixed ids and a `tar767` marker,
 * removed before the run as well as after it so an interrupted run cleans up on
 * the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '76744444-4444-7444-8444-444444444401';
const OTHER_TENANT = '76744444-4444-7444-8444-444444444402';
const BUSINESS_ACCOUNT = '76744444-4444-7444-8444-4444444444b1';
const NUMBER = '76744444-4444-7444-8444-4444444444c1';
const SECOND_NUMBER = '76744444-4444-7444-8444-4444444444c2';

const PHONE_NUMBER_ID = 'tar767-phone-number-id';
const SECOND_PHONE_NUMBER_ID = 'tar767-phone-number-id-2';

/**
 * A PIN whose leading zeros are the whole test. The contract generates the value
 * as a `string` for exactly this reason — a number type turns `000042` into 42,
 * and Meta then rejects a four-digit PIN.
 */
const PIN = '000042';

/** 32 bytes, base64. A fixture, and obviously not a key from a CSPRNG. */
const KEY = Buffer.alloc(32, 7).toString('base64');

const REQUEST_ID = 'tar767-int-spec';

function cipherWithFixtureKey(): WhatsAppCredentialCipher {
  const config = {
    get: (name: string) => (name === 'WHATSAPP_TOKEN_ENCRYPTION_KEY' ? KEY : undefined),
  } as unknown as ConfigService;

  return new WhatsAppCredentialCipher(config);
}

describe('the WhatsApp number registration schema', () => {
  const tenantContext = new TenantContextService();

  /**
   * The same class, constructed the same way, that
   * `WhatsAppBusinessAccountConnectionService` uses for
   * `access_token_encrypted`. Sharing the instance across both columns below is
   * deliberate — "the exact same encryption path" is a claim about one cipher,
   * one key and one payload format, and a second instance here would let a
   * second cipher pass this file unnoticed.
   */
  const cipher = cipherWithFixtureKey();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
  }

  /** The tenant, its WABA and one number, none of them naming a registration field. */
  async function createFixture(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar767-fixture', name: 'TAR-767 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar767-other', name: 'TAR-767 other', status: 'active' },
      ],
    });
    await systemPrisma.whatsappBusinessAccount.create({
      data: {
        id: BUSINESS_ACCOUNT,
        tenantId: TENANT,
        wabaId: 'tar767-waba-id',
        accessTokenEncrypted: cipher.encrypt('tar767-access-token', 'tar767-waba-id'),
      },
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: NUMBER,
          tenantId: TENANT,
          whatsappBusinessAccountId: BUSINESS_ACCOUNT,
          phoneNumberId: PHONE_NUMBER_ID,
          displayPhoneNumber: '+10000076701',
          status: 'connected',
        },
        {
          id: SECOND_NUMBER,
          tenantId: TENANT,
          whatsappBusinessAccountId: BUSINESS_ACCOUNT,
          phoneNumberId: SECOND_PHONE_NUMBER_ID,
          displayPhoneNumber: '+10000076702',
          status: 'connected',
        },
      ],
    });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await removeFixture();
    await createFixture();
  });

  describe('the default', () => {
    it('reads unregistered on a row that names no registration field', async () => {
      const number = await systemPrisma.whatsappAccount.findUniqueOrThrow({
        where: { id: NUMBER },
      });

      expect(number.registrationStatus).toBe('unregistered');
      expect(number.registrationPinEncrypted).toBeNull();
      expect(number.registrationFailureReason).toBeNull();
      expect(number.registeredAt).toBeNull();
      expect(number.registrationAttemptedAt).toBeNull();
    });

    it('is unregistered in the catalog, which is what covers rows already on disk', async () => {
      // The assertion the acceptance criterion actually turns on. A row written
      // before this migration ran is never visited by it: `ADD COLUMN` with a
      // non-volatile default records the value in `pg_attribute` and every such
      // row reads it. So the default *is* the migration's promise about existing
      // rows, and reading it out of the catalog is how that promise is checked
      // without a second database at the previous version.
      //
      // `failed` here would mark every connection made before today as a Meta
      // rejection that never happened.
      const [column] = await systemPrisma.$queryRaw<{ default: string; nullable: string }[]>`
        SELECT column_default AS "default", is_nullable AS nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'whatsapp_accounts'
           AND column_name = 'registration_status'
      `;

      expect(column?.default).toBe(`'unregistered'::whatsapp_registration_status`);
      expect(column?.nullable).toBe('NO');
    });

    it('carries the four labels the contract names, and no fifth', async () => {
      const labels = await systemPrisma.$queryRaw<{ label: string }[]>`
        SELECT enumlabel AS label
          FROM pg_enum
         WHERE enumtypid = 'public.whatsapp_registration_status'::regtype
         ORDER BY enumsortorder
      `;

      // `unregistered` and `failed` are separate on purpose: "never attempted"
      // is not "Meta refused", and the console's copy for the two differs.
      expect(labels.map((row) => row.label)).toEqual([
        'unregistered',
        'pending',
        'registered',
        'failed',
      ]);
    });

    it('leaves whatsapp_account_status alone', async () => {
      // Registration is a second axis, not a widening of `status`. A
      // `connected_unregistered` label here would break every existing
      // `= 'connected'` check, so its absence is worth asserting rather than
      // assuming.
      const labels = await systemPrisma.$queryRaw<{ label: string }[]>`
        SELECT enumlabel AS label
          FROM pg_enum
         WHERE enumtypid = 'public.whatsapp_account_status'::regtype
         ORDER BY enumsortorder
      `;

      expect(labels.map((row) => row.label)).toEqual(['connected', 'disconnected', 'error']);
    });
  });

  describe('the encrypted PIN', () => {
    it('round-trips through the cipher the access token already uses', async () => {
      // The acceptance criterion, end to end: encrypt as the registration
      // service will, store, read back out of PostgreSQL, decrypt.
      await systemPrisma.whatsappAccount.update({
        where: { id: NUMBER },
        data: { registrationPinEncrypted: cipher.encrypt(PIN, PHONE_NUMBER_ID) },
      });

      const stored = await systemPrisma.whatsappAccount.findUniqueOrThrow({
        where: { id: NUMBER },
        select: { registrationPinEncrypted: true },
      });

      expect(stored.registrationPinEncrypted).not.toBeNull();
      expect(cipher.decrypt(stored.registrationPinEncrypted as string, PHONE_NUMBER_ID)).toBe(PIN);
    });

    it('stores the same payload format the access token column stores', async () => {
      // Not decoration. `v1.<iv>.<tag>.<ciphertext>` is what makes a key
      // rotation possible without a migration, and a PIN written under some
      // second construction would still round-trip through *its own* cipher
      // while failing this — which is exactly the "no new encryption scheme"
      // the issue asks for.
      await systemPrisma.whatsappAccount.update({
        where: { id: NUMBER },
        data: { registrationPinEncrypted: cipher.encrypt(PIN, PHONE_NUMBER_ID) },
      });

      const [row] = await systemPrisma.$queryRaw<{ pin: string | null; token: string | null }[]>`
        SELECT n."registration_pin_encrypted" AS pin, b."access_token_encrypted" AS token
          FROM "whatsapp_accounts" n
          JOIN "whatsapp_business_accounts" b
            ON b."tenant_id" = n."tenant_id" AND b."id" = n."whatsapp_business_account_id"
         WHERE n."id" = ${NUMBER}::uuid
      `;

      const parts = row?.pin?.split('.') ?? [];

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      expect(row?.token?.split('.')).toHaveLength(4);
      expect(row?.token?.split('.')[0]).toBe('v1');
    });

    it('does not store the PIN in the clear', async () => {
      await systemPrisma.whatsappAccount.update({
        where: { id: NUMBER },
        data: { registrationPinEncrypted: cipher.encrypt(PIN, PHONE_NUMBER_ID) },
      });

      const stored = await systemPrisma.whatsappAccount.findUniqueOrThrow({
        where: { id: NUMBER },
        select: { registrationPinEncrypted: true },
      });

      expect(stored.registrationPinEncrypted).not.toContain(PIN);
    });

    it('refuses a PIN copied to another number of the same WABA', async () => {
      // Why the AAD is `phone_number_id` and not `waba_id`: the two numbers here
      // share a WABA, so a WABA-bound payload would decrypt in both rows and a
      // PIN moved between them would go to Meta as if it were that number's.
      const payload = cipher.encrypt(PIN, PHONE_NUMBER_ID);

      await systemPrisma.whatsappAccount.update({
        where: { id: SECOND_NUMBER },
        data: { registrationPinEncrypted: payload },
      });

      const stored = await systemPrisma.whatsappAccount.findUniqueOrThrow({
        where: { id: SECOND_NUMBER },
        select: { phoneNumberId: true, registrationPinEncrypted: true },
      });

      expect(() =>
        cipher.decrypt(stored.registrationPinEncrypted as string, stored.phoneNumberId),
      ).toThrow(WhatsAppTokenUndecryptableError);
    });
  });

  describe('tenant isolation', () => {
    it("hides another tenant's PIN from the app role", async () => {
      await systemPrisma.whatsappAccount.update({
        where: { id: NUMBER },
        data: {
          registrationPinEncrypted: cipher.encrypt(PIN, PHONE_NUMBER_ID),
          registrationStatus: 'registered',
          registeredAt: new Date(),
        },
      });

      // As `whatsappcrm_app`, which holds no BYPASSRLS. The policy predicates on
      // `tenant_id` and is column-agnostic, so this should already be true —
      // asserted because "should already be true" is how an isolation hole gets
      // shipped.
      await asTenant(OTHER_TENANT, async () => {
        await expect(
          tenantPrisma.whatsappAccount.findUnique({ where: { id: NUMBER } }),
        ).resolves.toBeNull();
      });

      await asTenant(TENANT, async () => {
        const number = await tenantPrisma.whatsappAccount.findUniqueOrThrow({
          where: { id: NUMBER },
        });

        expect(number.registrationStatus).toBe('registered');
      });
    });
  });

  describe('the failure reason', () => {
    it('is text, so a value this build does not model is readable rather than fatal', async () => {
      // The reason a rollback across a vocabulary addition is safe: a reason
      // written by a newer build has to come back as a string the reader can map
      // to `rejected`, not as a deserialise failure. An enum type here would
      // make that a data repair.
      await systemPrisma.$executeRaw`
        UPDATE "whatsapp_accounts"
           SET "registration_status" = 'failed',
               "registration_failure_reason" = 'a_reason_from_a_later_build'
         WHERE "id" = ${NUMBER}::uuid
      `;

      const number = await systemPrisma.whatsappAccount.findUniqueOrThrow({
        where: { id: NUMBER },
      });

      expect(number.registrationFailureReason).toBe('a_reason_from_a_later_build');
    });
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
