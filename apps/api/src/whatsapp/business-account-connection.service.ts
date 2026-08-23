import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  WhatsAppBusinessVerificationStatus,
  WhatsAppQualityRating,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { isUniqueViolationOn } from '../prisma/unique-violation';
import { WhatsAppCredentialCipher } from './whatsapp-credential.cipher';
import { WhatsAppIdentityTakenError } from './whatsapp.errors';

/**
 * Long enough for a WABA and a handful of numbers on a slow database, short
 * enough that a stuck connection releases its advisory lock rather than blocking
 * every other attempt on the same WABA behind it.
 */
const TRANSACTION_TIMEOUT_MS = 15_000;

/** Namespace for the advisory lock, so the hash cannot collide with a lock some other feature takes. */
const CONNECTION_LOCK_PREFIX = 'whatsapp-business-account:';

export interface ConnectPhoneNumberCommand {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName?: string;
  qualityRating?: WhatsAppQualityRating;
}

export interface ConnectBusinessAccountCommand {
  wabaId: string;
  name?: string;
  /** Plaintext, for the length of this call. Encrypted before it reaches a row. */
  accessToken: string;
  verificationStatus?: WhatsAppBusinessVerificationStatus;
  phoneNumbers: readonly ConnectPhoneNumberCommand[];
}

/** The columns the response is built from. The encrypted token is not among them. */
const WABA_PROJECTION = {
  id: true,
  wabaId: true,
  name: true,
  verificationStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The columns a connected number's response is built from.
 *
 * It widened by the four registration fields when TAR-170 landed, and by four
 * only: `registration_pin_encrypted` is **not** among them and must not be. The
 * PIN is a credential of the same class as the access token, and this projection
 * feeds a response mapper — the one place it could escape from.
 */
const ACCOUNT_PROJECTION = {
  id: true,
  whatsappBusinessAccountId: true,
  phoneNumberId: true,
  displayPhoneNumber: true,
  verifiedName: true,
  qualityRating: true,
  status: true,
  registrationStatus: true,
  registrationFailureReason: true,
  registeredAt: true,
  registrationAttemptedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ConnectedPhoneNumber = Prisma.WhatsappAccountGetPayload<{
  select: typeof ACCOUNT_PROJECTION;
}>;

export type ConnectedBusinessAccount = Prisma.WhatsappBusinessAccountGetPayload<{
  select: typeof WABA_PROJECTION;
}> & { accounts: ConnectedPhoneNumber[] };

export interface ConnectBusinessAccountResult {
  businessAccount: ConnectedBusinessAccount;
  /** False when this WABA was already connected and the call updated it. */
  created: boolean;
}

/**
 * Connects a WhatsApp Business Account and its phone numbers to the tenant in
 * scope (TAR-20a).
 *
 * ## Isolation
 *
 * Everything goes through `TenantPrisma`, so TAR-48's `tenant_isolation` policy
 * filters every read and checks every write, and the composite foreign key
 * `(tenant_id, whatsapp_business_account_id)` makes attaching a number to
 * another tenant's WABA fail in the database rather than in a forgotten `where`.
 * The row this writes holds the encrypted access token, which is the most
 * sensitive column in the schema — it is not a table to reach through
 * `SystemPrisma` and a hand-written filter.
 *
 * ## Idempotency
 *
 * `wabaId` is the identity of the request. The whole operation runs in one
 * transaction that first takes a transaction-scoped advisory lock on that id, so
 * two operators connecting the same WABA at once produce one row and one audit
 * entry. A repeat call **updates** rather than duplicating, which is also how a
 * token is rotated: re-connect with the new one.
 *
 * The numbers in the payload are created or updated. Numbers **absent** from it
 * are left alone — never deleted. Disconnecting a number stops inbound webhooks
 * resolving to a tenant and orphans its conversations, so it is a deliberate
 * operation of its own, not a side effect of omitting a line from a request
 * body.
 *
 * ## What it does not do
 *
 * It does not call Meta. A connection that verified the token would fail while
 * Meta was down, for a credential that is very likely fine; the first template
 * sync is where a bad token surfaces, with an error that says so. It also does
 * not sync templates — that is one call further on, so that a Meta outage cannot
 * make an otherwise-successful connection look like a failure.
 */
@Injectable()
export class WhatsAppBusinessAccountConnectionService {
  private readonly logger = new Logger(WhatsAppBusinessAccountConnectionService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly cipher: WhatsAppCredentialCipher,
    private readonly audit: AuditService,
  ) {}

  async connect(command: ConnectBusinessAccountCommand): Promise<ConnectBusinessAccountResult> {
    const tenantId = this.tenantContext.requireTenantId();
    // Encrypted before the transaction opens, so a missing key fails the request
    // without having held a lock or opened a transaction. It also keeps the
    // plaintext out of every frame below this one.
    const accessTokenEncrypted = this.cipher.encrypt(command.accessToken, command.wabaId);

    const result = await this.prisma
      .$tenantTransaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CONNECTION_LOCK_PREFIX + command.wabaId}))`;

          const existing = await tx.whatsappBusinessAccount.findUnique({
            where: { wabaId: command.wabaId },
            select: { id: true },
          });

          const businessAccount =
            existing === null
              ? await createBusinessAccount(tx, tenantId, command, accessTokenEncrypted)
              : await updateBusinessAccount(tx, existing.id, command, accessTokenEncrypted);

          const accounts = await connectPhoneNumbers(
            tx,
            tenantId,
            businessAccount.id,
            command.phoneNumbers,
          );

          await this.recordAudit(tx, businessAccount.id, command);

          return {
            businessAccount: { ...businessAccount, accounts },
            created: existing === null,
          };
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      )
      .catch((error: unknown) => translateCollision(error, command));

    this.logger.log(
      `${result.created ? 'Connected' : 'Updated'} WhatsApp business account ${command.wabaId} ` +
        `for tenant ${tenantId} with ${result.businessAccount.accounts.length} phone number(s)`,
    );

    return result;
  }

  /**
   * Connecting a WABA hands the platform a credential that can message a
   * business's customers in its name, so it is audited like any other
   * security-relevant change (TAR-39, security).
   *
   * Through `AuditService` rather than `tx.auditLog.create` (TAR-166). The write
   * is identical in every respect that reaches a row except one: the actor is
   * resolved from the request scope instead of being assumed. That is what makes
   * the operator path record *which* operator connected it, and what will make
   * the tenant-facing route record the tenant admin who did — without this
   * method learning that either path exists.
   *
   * The metadata records which WABA and which numbers, and — stated because it
   * is the point — **never the token, encrypted or not**, and never the Embedded
   * Signup code that a later path exchanges for one.
   */
  private async recordAudit(
    tx: Prisma.TransactionClient,
    whatsappBusinessAccountId: string,
    command: ConnectBusinessAccountCommand,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: AUDIT_ACTIONS.whatsappBusinessAccountConnected,
      targetType: 'whatsapp_business_account',
      targetId: whatsappBusinessAccountId,
      metadata: {
        wabaId: command.wabaId,
        phoneNumberIds: command.phoneNumbers.map((number) => number.phoneNumberId),
      },
    });
  }
}

async function createBusinessAccount(
  tx: Prisma.TransactionClient,
  tenantId: string,
  command: ConnectBusinessAccountCommand,
  accessTokenEncrypted: string,
) {
  return tx.whatsappBusinessAccount.create({
    data: {
      // Supplied explicitly: the tenant-scope extension filters reads through
      // RLS but injects nothing into `data`, and `tenant_id` is NOT NULL. The
      // policy's WITH CHECK is what makes a wrong value here fail rather than
      // land in a neighbour's tenant.
      tenantId,
      wabaId: command.wabaId,
      name: command.name ?? null,
      accessTokenEncrypted,
      verificationStatus: command.verificationStatus ?? 'not_verified',
    },
    select: WABA_PROJECTION,
  });
}

/**
 * The token is re-encrypted and written on every call, which is what makes
 * re-connecting the rotation path. `name` and `verificationStatus` are written
 * only when supplied, so a connection request that omits them does not erase
 * what a previous one recorded.
 */
async function updateBusinessAccount(
  tx: Prisma.TransactionClient,
  id: string,
  command: ConnectBusinessAccountCommand,
  accessTokenEncrypted: string,
) {
  return tx.whatsappBusinessAccount.update({
    where: { id },
    data: {
      accessTokenEncrypted,
      ...(command.name === undefined ? {} : { name: command.name }),
      ...(command.verificationStatus === undefined
        ? {}
        : { verificationStatus: command.verificationStatus }),
    },
    select: WABA_PROJECTION,
  });
}

/**
 * Sequential rather than `Promise.all`: these run inside one interactive
 * transaction, which is a single connection, so concurrency here would only
 * interleave statements on the same wire. The list is capped at 20 by the
 * request schema.
 */
async function connectPhoneNumbers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  whatsappBusinessAccountId: string,
  numbers: readonly ConnectPhoneNumberCommand[],
): Promise<ConnectedPhoneNumber[]> {
  const connected: ConnectedPhoneNumber[] = [];

  for (const number of numbers) {
    const existing = await tx.whatsappAccount.findUnique({
      where: { phoneNumberId: number.phoneNumberId },
      select: { id: true },
    });

    connected.push(
      existing === null
        ? await tx.whatsappAccount.create({
            data: {
              tenantId,
              whatsappBusinessAccountId,
              phoneNumberId: number.phoneNumberId,
              displayPhoneNumber: number.displayPhoneNumber,
              verifiedName: number.verifiedName ?? null,
              qualityRating: number.qualityRating ?? null,
              status: 'connected',
            },
            select: ACCOUNT_PROJECTION,
          })
        : await tx.whatsappAccount.update({
            where: { id: existing.id },
            data: {
              // A number may legitimately move between two WABAs the same tenant
              // holds; the composite foreign key refuses a move across tenants.
              whatsappBusinessAccountId,
              displayPhoneNumber: number.displayPhoneNumber,
              status: 'connected',
              ...(number.verifiedName === undefined ? {} : { verifiedName: number.verifiedName }),
              // Meta's rating, not ours to reset: an omitted value means "not
              // reported in this request", never "no longer rated".
              ...(number.qualityRating === undefined
                ? {}
                : { qualityRating: number.qualityRating }),
            },
            select: ACCOUNT_PROJECTION,
          }),
    );
  }

  return connected;
}

/**
 * `waba_id` and `phone_number_id` are unique **globally**, because one Meta app
 * serves every tenant and an id arriving on a webhook has to resolve to exactly
 * one row. Under RLS the pre-read cannot see a neighbour's row, so a collision
 * surfaces here as the insert failing — which is the correct place for it to
 * fail, and the reason this is translated rather than left as a 500.
 */
function translateCollision(error: unknown, command: ConnectBusinessAccountCommand): never {
  if (isUniqueViolationOn(error, 'waba_id')) {
    throw new WhatsAppIdentityTakenError('waba', command.wabaId);
  }

  if (isUniqueViolationOn(error, 'phone_number_id')) {
    // Which of the numbers collided is not in the error, and reading the row to
    // find out would need `SystemPrisma` against another tenant's data. The
    // operator has the list they sent; naming them back is enough to act on.
    throw new WhatsAppIdentityTakenError(
      'phone-number',
      command.phoneNumbers.map((number) => number.phoneNumberId).join(', '),
    );
  }

  throw error;
}
