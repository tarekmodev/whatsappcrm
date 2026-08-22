import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  WhatsAppRegistrationFailureReason,
  WhatsAppRegistrationStatus,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { MetaCloudApiClient } from './meta-cloud-api.client';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
  type MetaErrorDetail,
} from './meta-cloud-api.errors';
import { readRegistrationFailureReason } from './registration-failure-reason';
import { WhatsAppCredentialCipher } from './whatsapp-credential.cipher';
import { WhatsAppTokenUndecryptableError } from './whatsapp.errors';

/**
 * Namespace for the advisory lock. Its own prefix rather than the connection's,
 * so claiming a number cannot collide with `connect()`'s WABA-wide lock — the
 * two are taken for different reasons and one waiting on the other would be a
 * deadlock waiting for a busy afternoon.
 */
const REGISTRATION_LOCK_PREFIX = 'whatsapp-registration:';

/**
 * Short: it holds an advisory lock and one row, and never spans the Meta call.
 * Both transactions here are two statements and a commit.
 */
const TRANSACTION_TIMEOUT_MS = 5_000;

/** Meta's PIN space. Six digits, so `[0, 1_000_000)`. */
const PIN_UPPER_BOUND = 1_000_000;
const PIN_DIGITS = 6;

/** What a caller asks this service to do. */
export interface RegisterNumberCommand {
  /** Our id for the `whatsapp_accounts` row. */
  whatsappAccountId: string;
  /** Meta's id for the number. Also the PIN's additional authenticated data. */
  phoneNumberId: string;
  /**
   * The WABA's access token, in hand on the connection path because the code
   * exchange has just produced it and the row it would be read from is not
   * written until the same request commits.
   */
  accessToken: string;
  /** Meta's id for the WABA, for the audit row. Never sent to Meta by this call. */
  wabaId: string;
}

/** The registration half of a number's state, as both callers report it. */
export interface NumberRegistrationState {
  whatsappAccountId: string;
  phoneNumberId: string;
  registrationStatus: WhatsAppRegistrationStatus;
  registrationFailureReason: WhatsAppRegistrationFailureReason | null;
  registeredAt: Date | null;
  registrationAttemptedAt: Date | null;
}

/** The columns an attempt needs, and the only projection that reads the PIN. */
const REGISTRATION_PROJECTION = {
  id: true,
  phoneNumberId: true,
  registrationStatus: true,
  registrationPinEncrypted: true,
  registrationFailureReason: true,
  registeredAt: true,
  registrationAttemptedAt: true,
} as const;

/**
 * Registers a connected phone number for Cloud API sending (TAR-170, 0002
 * amendment 12).
 *
 * ## Why this exists at all
 *
 * A number attached through Embedded Signup receives the moment the app is
 * subscribed to its WABA's webhooks, and refuses every send until
 * `POST /{phone-number-id}/register` has been called for it. Without this step a
 * tenant completes onboarding, watches messages arrive, and discovers on the
 * first reply that the connection was only ever half a connection.
 *
 * ## Three steps, two short transactions, one Meta call between them
 *
 * **TX-A — claim.** Take the advisory lock, read the row, decide whether an
 * attempt is owed, generate and encrypt a PIN if the row has none, and mark the
 * row `pending`. **The lock is released at commit, before the Meta call** — no
 * transaction is ever open across a network round trip, which is the property
 * `connect()` protects for the same reason and at greater cost.
 *
 * **The Meta call**, holding nothing.
 *
 * **TX-B — record.** Write the outcome *only if the row still reads `pending`*.
 * If another attempt has taken it over in the meantime, the outcome is audited
 * and the status left alone: that compare-and-set is what stops a slow loser
 * downgrading a `registered` row to `failed`.
 *
 * The PIN is durable **before** it reaches Meta, and that ordering is the whole
 * design. Every other Meta call in the signup flow happens before any row is
 * written, so a failure leaves nothing to clean up. This one cannot follow that
 * rule: it sends a credential this platform invents, so a registration that
 * succeeded against a PIN that was never committed leaves Meta holding a secret
 * nobody here can reproduce.
 *
 * ## What it never does
 *
 * It never fails its caller's request. A registration failure is a *state on the
 * number*, reported through the returned state and the row, because the
 * connection that carries it succeeded and rolling that back would trade a
 * working inbound connection for a send-side failure that is usually transient
 * and always retryable.
 *
 * It never logs, returns, or audits the PIN — encrypted or not.
 */
@Injectable()
export class WhatsAppPhoneNumberRegistrationService {
  private readonly logger = new Logger(WhatsAppPhoneNumberRegistrationService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly cipher: WhatsAppCredentialCipher,
    private readonly meta: MetaCloudApiClient,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async register(command: RegisterNumberCommand): Promise<NumberRegistrationState> {
    const claim = await this.claim(command);

    if (claim.pin === null) {
      return claim.state;
    }

    try {
      await this.meta.registerPhoneNumber({
        phoneNumberId: command.phoneNumberId,
        accessToken: command.accessToken,
        pin: claim.pin,
      });
    } catch (error: unknown) {
      return this.recordFailure(command, error);
    }

    return this.recordSuccess(command);
  }

  /**
   * TX-A. Returns the PIN to attempt with, or `null` when no attempt is owed —
   * the row already reads `registered`, or another attempt is genuinely in
   * flight.
   */
  private async claim(
    command: RegisterNumberCommand,
  ): Promise<{ pin: string | null; state: NumberRegistrationState }> {
    return this.prisma.$tenantTransaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${REGISTRATION_LOCK_PREFIX + command.phoneNumberId}))`;

        const row = await tx.whatsappAccount.findUnique({
          where: { id: command.whatsappAccountId },
          select: REGISTRATION_PROJECTION,
        });

        if (row === null) {
          // The row is read inside the same request that created it, through
          // `TenantPrisma`, so absent means it belongs to another tenant or has
          // been removed between the two. Neither is this service's to resolve.
          throw new WhatsAppAccountRegistrationTargetMissingError(command.whatsappAccountId);
        }

        if (row.registrationStatus === 'registered' || this.isAttemptInFlight(row)) {
          return { pin: null, state: toState(row) };
        }

        const pin = this.resolvePin(row);
        const attemptedAt = new Date();

        await tx.whatsappAccount.update({
          where: { id: command.whatsappAccountId },
          data: {
            registrationStatus: 'pending',
            registrationAttemptedAt: attemptedAt,
            // Cleared here rather than only on success, so the column keeps its
            // stated meaning: why the last *completed* attempt failed. A row
            // left `pending` by a killed process would otherwise carry the
            // previous failure's reason and read as though it had failed again.
            registrationFailureReason: null,
            // Re-encrypted on every attempt, so a fresh IV each time and a row
            // whose ciphertext had stopped authenticating is repaired in place.
            registrationPinEncrypted: this.cipher.encrypt(pin, command.phoneNumberId),
          },
          select: { id: true },
        });

        return {
          pin,
          state: {
            ...toState(row),
            registrationStatus: 'pending',
            registrationFailureReason: null,
            registrationAttemptedAt: attemptedAt,
          },
        };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * A `pending` row younger than one Meta timeout is an attempt that is very
   * likely still running; an older one is an attempt that died between the call
   * and TX-B. The lease is a heuristic, not a lock — the compare-and-set in TX-B
   * is what makes losing the race harmless.
   */
  private isAttemptInFlight(row: {
    registrationStatus: WhatsAppRegistrationStatus;
    registrationAttemptedAt: Date | null;
  }): boolean {
    if (row.registrationStatus !== 'pending' || row.registrationAttemptedAt === null) {
      return false;
    }

    const leaseMs = this.config.getOrThrow<number>('META_GRAPH_API_TIMEOUT_MS');

    return Date.now() - row.registrationAttemptedAt.getTime() < leaseMs;
  }

  /**
   * The stored PIN, or a fresh one when the column is empty or will not
   * authenticate.
   *
   * An undecryptable PIN — a rotated key, a truncated column — is treated as no
   * PIN rather than as an error. `WhatsAppTokenUndecryptableError`'s message is
   * about the *access token* ("re-connect the business account to supply the
   * token again") and would send a tenant to do something that has nothing to do
   * with this, so it is caught here and never surfaces. If Meta then refuses
   * because the number is registered under the PIN this platform lost, that
   * arrives as an ordinary registration failure with a reason, which is the
   * honest outcome.
   */
  private resolvePin(row: {
    phoneNumberId: string;
    registrationPinEncrypted: string | null;
  }): string {
    if (row.registrationPinEncrypted === null) {
      return generatePin();
    }

    try {
      return this.cipher.decrypt(row.registrationPinEncrypted, row.phoneNumberId);
    } catch (error: unknown) {
      if (!(error instanceof WhatsAppTokenUndecryptableError)) {
        throw error;
      }

      this.logger.warn(
        `The stored registration PIN for phone number ${row.phoneNumberId} could not be ` +
          'decrypted; registering with a fresh one. If Meta refuses, the number is registered ' +
          'under a PIN this platform no longer holds and needs a PIN reset at Meta.',
      );

      return generatePin();
    }
  }

  /** TX-B, success. */
  private async recordSuccess(command: RegisterNumberCommand): Promise<NumberRegistrationState> {
    const registeredAt = new Date();

    const state = await this.prisma.$tenantTransaction(
      async (tx) => {
        const owned = await this.claimStillHeld(tx, command.whatsappAccountId, {
          registrationStatus: 'registered',
          registrationFailureReason: null,
          registeredAt,
        });

        await this.audit.record(tx, {
          action: AUDIT_ACTIONS.whatsappPhoneNumberRegistered,
          targetType: 'whatsapp_account',
          targetId: command.whatsappAccountId,
          metadata: {
            phoneNumberId: command.phoneNumberId,
            wabaId: command.wabaId,
            // Literal while the connection flow is the only caller. The retry
            // route (TAR-769) carries its own value on the command rather than
            // this service inferring one, because only the caller knows.
            attempt: 'initial',
          },
        });

        return owned;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    this.logger.log(`Registered WhatsApp phone number ${command.phoneNumberId} for sending`);

    return state;
  }

  /** TX-B, failure. */
  private async recordFailure(
    command: RegisterNumberCommand,
    error: unknown,
  ): Promise<NumberRegistrationState> {
    const failure = readMetaFailure(error);

    if (failure === null) {
      // Not a Meta failure: a bug, a missing encryption key, a database fault.
      // Nothing about the attempt is known, so nothing is written — the row
      // stays `pending` and the lease expires, which is exactly what a process
      // killed at this point would leave behind.
      throw error;
    }

    const { reason, detail } = failure;

    const state = await this.prisma.$tenantTransaction(
      async (tx) => {
        const owned = await this.claimStillHeld(tx, command.whatsappAccountId, {
          registrationStatus: 'failed',
          registrationFailureReason: reason,
        });

        await this.audit.record(tx, {
          action: AUDIT_ACTIONS.whatsappPhoneNumberRegistrationFailed,
          targetType: 'whatsapp_account',
          targetId: command.whatsappAccountId,
          metadata: {
            phoneNumberId: command.phoneNumberId,
            wabaId: command.wabaId,
            attempt: 'initial',
            reason,
            ...metaHandles(detail),
          },
        });

        return owned;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    this.logger.warn(
      `Registering WhatsApp phone number ${command.phoneNumberId} failed as ${reason}. ` +
        'The number still receives; sending is unavailable until a retry succeeds.',
    );

    return state;
  }

  /**
   * Writes the outcome **only if this attempt still owns the row**, and reads
   * back whatever the row actually says either way.
   *
   * `updateMany` rather than `update`, because a compare-and-set that matches
   * nothing has to be an ordinary zero-row result rather than a thrown
   * not-found: losing the race is a normal outcome here, not a fault.
   */
  private async claimStillHeld(
    tx: Prisma.TransactionClient,
    whatsappAccountId: string,
    outcome: Prisma.WhatsappAccountUpdateManyMutationInput,
  ): Promise<NumberRegistrationState> {
    const written = await tx.whatsappAccount.updateMany({
      where: { id: whatsappAccountId, registrationStatus: 'pending' },
      data: outcome,
    });

    const row = await tx.whatsappAccount.findUniqueOrThrow({
      where: { id: whatsappAccountId },
      select: REGISTRATION_PROJECTION,
    });

    if (written.count === 0) {
      this.logger.warn(
        `A concurrent attempt had already taken phone number ${row.phoneNumberId} over; its ` +
          `outcome stands and this one is recorded in the audit trail only.`,
      );
    }

    return toState(row);
  }
}

/**
 * Thrown when the row an attempt was asked to register is not reachable — an id
 * that names nothing, or a row belonging to another tenant, which RLS makes
 * indistinguishable from absent and which TAR-39 requires stay that way.
 *
 * Declared here rather than in `whatsapp.errors.ts` because nothing outside this
 * file can produce it: the connection path passes an id it has just written in
 * the same request.
 */
export class WhatsAppAccountRegistrationTargetMissingError extends Error {
  constructor(readonly whatsappAccountId: string) {
    super(
      `The WhatsApp phone number ${whatsappAccountId} could not be registered because its record ` +
        'is no longer reachable.',
    );
    this.name = 'WhatsAppAccountRegistrationTargetMissingError';
  }
}

/**
 * Six digits from a CSPRNG, leading zeros kept.
 *
 * `randomInt` rather than `randomBytes(4) % 1_000_000`: the modulo is biased and
 * `randomInt` rejection-samples. No weak-PIN filter — the value comes from a
 * CSPRNG, is stored encrypted, and is never typed by a human, so excluding
 * `000000` and `123456` would only remove entropy from a space Meta has already
 * capped at a million.
 */
function generatePin(): string {
  return String(randomInt(0, PIN_UPPER_BOUND)).padStart(PIN_DIGITS, '0');
}

/**
 * Which published reason a failed attempt carries, and Meta's own account of it
 * — the same mapping on the first attempt and on a retry, so a console renders
 * one set of strings whichever produced the row.
 *
 * `null` means "not a Meta failure", which the caller re-throws: a bug or a
 * fault must not be recorded on the row as though Meta had answered.
 *
 * **Every `MetaRequestRejectedError` maps to `rejected` for now.** Meta's numeric
 * codes for "already registered" and "PIN mismatch" are not asserted by 0002
 * amendment 12 and have not been confirmed against a live app, and a wrong guess
 * would send somebody to reset a PIN that was never the problem. `rejected`
 * sends them to the audit row instead, where Meta's own code and `fbtrace_id`
 * are. `already_registered` is still written — by the short-circuit on a row that
 * already reads `registered`, which needs no code from Meta to be sure of.
 */
function readMetaFailure(
  error: unknown,
): { reason: WhatsAppRegistrationFailureReason; detail: MetaErrorDetail | null } | null {
  if (error instanceof MetaAuthenticationError) {
    return { reason: 'credential_rejected', detail: error.detail };
  }

  if (error instanceof MetaRateLimitedError) {
    return { reason: 'rate_limited', detail: error.detail };
  }

  if (error instanceof MetaUnavailableError) {
    return { reason: 'upstream_unavailable', detail: error.detail };
  }

  if (error instanceof MetaRequestRejectedError) {
    return { reason: 'rejected', detail: error.detail };
  }

  return null;
}

/**
 * Meta's own code and trace id for the audit row — the handle a support ticket
 * with Meta is opened on.
 *
 * Meta's free-text message is deliberately **not** carried: it describes this
 * app's grant and this app's configuration, and the audit table is exported for
 * compliance review.
 */
function metaHandles(detail: MetaErrorDetail | null): { metaCode?: number; metaTraceId?: string } {
  return {
    ...(detail?.code == null ? {} : { metaCode: detail.code }),
    ...(detail?.traceId == null ? {} : { metaTraceId: detail.traceId }),
  };
}

function toState(row: {
  id: string;
  phoneNumberId: string;
  registrationStatus: WhatsAppRegistrationStatus;
  registrationFailureReason: string | null;
  registeredAt: Date | null;
  registrationAttemptedAt: Date | null;
}): NumberRegistrationState {
  return {
    whatsappAccountId: row.id,
    phoneNumberId: row.phoneNumberId,
    registrationStatus: row.registrationStatus,
    registrationFailureReason: readRegistrationFailureReason(row.registrationFailureReason),
    registeredAt: row.registeredAt,
    registrationAttemptedAt: row.registrationAttemptedAt,
  };
}
