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
import { WhatsAppCredentialCipher } from './whatsapp-credential.cipher';
import { MetaCloudApiClient } from './meta-cloud-api.client';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
  type MetaErrorDetail,
} from './meta-cloud-api.errors';
import { toWhatsAppRegistrationFailureReason } from './registration-failure-reason';
import { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';
import { WhatsAppAccountNotFoundError, WhatsAppTokenUndecryptableError } from './whatsapp.errors';

/**
 * Short: each transaction here is a lock, a read and a write against one row by
 * primary key. Anything slower than this is a database in trouble, and holding
 * the advisory lock longer would queue every other attempt on the same number.
 */
const TRANSACTION_TIMEOUT_MS = 5_000;

/**
 * Its own namespace, so the hash cannot collide with the WABA-wide lock
 * `business-account-connection.service.ts` takes while connecting: the two run
 * back to back on the signup path and must not serialise against each other.
 *
 * Keyed on our own row id rather than Meta's `phone_number_id`. The two are 1:1
 * so the exclusion is the same, and the row id is the value a caller already
 * holds — locking on Meta's id would mean reading the row to find out what to
 * lock, which is the read the lock exists to protect.
 */
const REGISTRATION_LOCK_PREFIX = 'whatsapp-registration:';

/** Meta's PIN space: six digits, `000000`–`999999`. */
const PIN_UPPER_BOUND = 1_000_000;
const PIN_DIGITS = 6;

/**
 * The only projection that reads `registration_pin_encrypted`, beside
 * `WABA_CREDENTIAL_PROJECTION`'s precedent in the resolver. One place, so
 * widening a `select` elsewhere cannot pull the PIN into a query that was not
 * meant to have it.
 */
const REGISTRATION_PROJECTION = {
  id: true,
  phoneNumberId: true,
  registrationStatus: true,
  registrationPinEncrypted: true,
  registrationFailureReason: true,
  registeredAt: true,
  registrationAttemptedAt: true,
  whatsappBusinessAccount: { select: { wabaId: true } },
} as const;

/** The state the console reads. Deliberately no PIN, in any form. */
const STATE_PROJECTION = {
  id: true,
  phoneNumberId: true,
  registrationStatus: true,
  registrationFailureReason: true,
  registeredAt: true,
  registrationAttemptedAt: true,
} as const;

export interface RegisterNumberCommand {
  /** Our id for the `whatsapp_accounts` row. */
  whatsappAccountId: string;
  /**
   * The WABA's access token. Supplied on the signup path, where it is already in
   * hand and is not yet readable from the row this request is creating; resolved
   * through `WhatsAppCredentialResolver` when it is absent.
   */
  accessToken?: string;
  /** Which audit story this attempt belongs to. */
  attempt: 'initial' | 'retry';
}

export interface NumberRegistrationState {
  whatsappAccountId: string;
  phoneNumberId: string;
  registrationStatus: WhatsAppRegistrationStatus;
  registrationFailureReason: WhatsAppRegistrationFailureReason | null;
  registeredAt: Date | null;
  registrationAttemptedAt: Date | null;
}

/**
 * Registers a connected phone number for Cloud API **sending** (TAR-170, 0002
 * amendment 12).
 *
 * A number attached through Embedded Signup receives from the moment the app is
 * subscribed to its webhooks and refuses every send until Meta has been told
 * `POST /{phone-number-id}/register` with a six-digit PIN. This service is the
 * one place that call is made, and the one place its outcome becomes state a
 * tenant can see.
 *
 * ## One method, two callers
 *
 * The signup flow drives `register` immediately after a connection commits, and
 * the retry route drives the same method later. That is deliberate and is the
 * whole reason the retry route exists as a second *caller* rather than a second
 * *implementation*: the state written and the reason published are identical
 * whichever path produced them, so the console needs one parser and one set of
 * strings.
 *
 * ## Three steps, two short transactions, one Meta call between them
 *
 * **TX-A claims the row.** It takes an advisory lock on the phone number id,
 * decides whether an attempt is warranted at all, resolves the PIN, and marks
 * the row `pending`. It commits — releasing the lock — *before* Meta is called.
 * No transaction is ever open across a network round trip: doing so would put a
 * Postgres connection and a per-number lock at the mercy of
 * `META_GRAPH_API_TIMEOUT_MS`.
 *
 * **TX-B records the outcome**, but only if the row still reads `pending`. If
 * another attempt took the row over in the meantime, the outcome is logged and
 * audited and the status is left alone — which is what stops a slow loser
 * downgrading a `registered` row to `failed`.
 *
 * Between the two, the lease on `registration_attempted_at` is what serialises
 * attempts: a `pending` row younger than the Graph timeout is an attempt
 * genuinely in flight, and an older one is an attempt that died without an
 * answer.
 *
 * ## The PIN
 *
 * Generated here with `randomInt`, stored encrypted by the same cipher and key
 * as the access token, and **reused** on every subsequent attempt. Reuse is a
 * hard requirement rather than a convenience: if a registration succeeds and the
 * outcome write is then lost, the number is registered at Meta under a PIN only
 * this column holds, and a retry with a fresh one would be refused.
 *
 * It is never logged at any level, never written to an audit row, and published
 * by no response schema.
 */
@Injectable()
export class WhatsAppPhoneNumberRegistrationService {
  private readonly logger = new Logger(WhatsAppPhoneNumberRegistrationService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly config: ConfigService,
    private readonly cipher: WhatsAppCredentialCipher,
    private readonly credentials: WhatsAppCredentialResolver,
    private readonly meta: MetaCloudApiClient,
    private readonly audit: AuditService,
  ) {}

  async register(command: RegisterNumberCommand): Promise<NumberRegistrationState> {
    // Resolved before the row is claimed, so a WABA whose token is missing or
    // undecryptable fails the request outright instead of leaving a `pending`
    // row behind for a lease to clean up. It also doubles as the existence
    // check: an id naming nothing reachable is absent here, under RLS, rather
    // than three statements later.
    const accessToken = command.accessToken ?? (await this.resolveAccessToken(command));

    const claim = await this.claim(command.whatsappAccountId);

    if (claim.kind === 'settled') {
      return claim.state;
    }

    try {
      await this.meta.registerPhoneNumber({
        phoneNumberId: claim.phoneNumberId,
        accessToken,
        pin: claim.pin,
      });
    } catch (error: unknown) {
      return this.record(command, claim, failureOf(error));
    }

    return this.record(command, claim, null);
  }

  private async resolveAccessToken(command: RegisterNumberCommand): Promise<string> {
    const credentials = await this.credentials.forPhoneNumber(command.whatsappAccountId);

    return credentials.accessToken;
  }

  /**
   * TX-A. Under the per-number advisory lock: read the row, decide whether to
   * attempt at all, and mark it `pending` when the answer is yes.
   *
   * The three settled answers are the ones that must not reach Meta — a number
   * that is already registered, and a number whose attempt is genuinely still
   * in flight. Both are reported as the current state rather than as an error,
   * because neither is one: "already registered" is the outcome the caller
   * wanted.
   */
  private async claim(whatsappAccountId: string): Promise<ClaimOutcome> {
    const leaseMs = this.config.getOrThrow<number>('META_GRAPH_API_TIMEOUT_MS');

    return this.prisma.$tenantTransaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${REGISTRATION_LOCK_PREFIX + whatsappAccountId}))`;

        const account = await tx.whatsappAccount.findUnique({
          where: { id: whatsappAccountId },
          select: REGISTRATION_PROJECTION,
        });

        if (account === null) {
          throw new WhatsAppAccountNotFoundError(whatsappAccountId);
        }

        if (account.registrationStatus === 'registered' || this.isInFlight(account, leaseMs)) {
          return { kind: 'settled', state: toState(account) } as const;
        }

        const pin = this.pinFor(account);
        const attemptedAt = new Date();

        await tx.whatsappAccount.update({
          where: { id: whatsappAccountId },
          data: {
            registrationStatus: 'pending',
            registrationAttemptedAt: attemptedAt,
            // Written on every attempt, not only when it was generated: a
            // re-encryption under a rotated key is exactly how a row whose
            // ciphertext stopped authenticating recovers.
            registrationPinEncrypted: this.cipher.encrypt(pin, account.phoneNumberId),
          },
          select: { id: true },
        });

        return {
          kind: 'claimed',
          whatsappAccountId,
          phoneNumberId: account.phoneNumberId,
          wabaId: account.whatsappBusinessAccount.wabaId,
          pin,
          attemptedAt,
        } as const;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * A `pending` row younger than one Graph timeout is an attempt still running
   * somewhere. Older than that, the attempt cannot still be waiting on Meta —
   * `AbortSignal.timeout` in the client guarantees it — so the row is taken
   * over.
   *
   * A heuristic rather than a lock, and knowingly so: a paused process could
   * outlive its own timeout. The compare-and-set in `record` is what makes the
   * consequence of losing that race harmless.
   */
  private isInFlight(
    account: {
      registrationStatus: WhatsAppRegistrationStatus;
      registrationAttemptedAt: Date | null;
    },
    leaseMs: number,
  ): boolean {
    if (account.registrationStatus !== 'pending' || account.registrationAttemptedAt === null) {
      return false;
    }

    return Date.now() - account.registrationAttemptedAt.getTime() < leaseMs;
  }

  /**
   * The stored PIN, or a fresh one when there is none — or when the stored one
   * will not authenticate.
   *
   * An undecryptable PIN is treated as no PIN. `WhatsAppTokenUndecryptableError`
   * exists for the access token and says "re-connect the business account to
   * supply the token again", which is not the repair for this and must not be
   * shown for it. So it is caught here, named in a log line, and registration
   * proceeds with a new PIN. If Meta then refuses because the number is
   * registered under the PIN this platform lost, that surfaces as an ordinary
   * registration failure with a reason — which is the honest outcome.
   */
  private pinFor(account: {
    phoneNumberId: string;
    registrationPinEncrypted: string | null;
  }): string {
    if (account.registrationPinEncrypted === null) {
      return generatePin();
    }

    try {
      return this.cipher.decrypt(account.registrationPinEncrypted, account.phoneNumberId);
    } catch (error: unknown) {
      if (!(error instanceof WhatsAppTokenUndecryptableError)) {
        throw error;
      }

      this.logger.warn(
        `The stored registration PIN for phone number ${account.phoneNumberId} could not be ` +
          'decrypted; registering with a freshly generated one.',
      );

      return generatePin();
    }
  }

  /**
   * TX-B. Write the outcome if — and only if — the row still reads `pending`,
   * then audit the attempt either way.
   *
   * The compare-and-set is the whole point. Two attempts can race despite the
   * lease; the loser's `UPDATE` matches no row, so a `registered` number is
   * never downgraded to `failed` by an attempt that finished second. Its audit
   * row is still written, because what Meta answered is a fact worth keeping
   * even when it did not decide the state.
   */
  private async record(
    command: RegisterNumberCommand,
    claim: ClaimedRow,
    failure: RegistrationFailure | null,
  ): Promise<NumberRegistrationState> {
    return this.prisma.$tenantTransaction(
      async (tx) => {
        const { count } = await tx.whatsappAccount.updateMany({
          where: { id: claim.whatsappAccountId, registrationStatus: 'pending' },
          data:
            failure === null
              ? {
                  registrationStatus: 'registered',
                  registeredAt: new Date(),
                  registrationFailureReason: null,
                }
              : {
                  registrationStatus: 'failed',
                  registrationFailureReason: failure.reason,
                },
        });

        if (count === 0) {
          this.logger.warn(
            `Registration of phone number ${claim.phoneNumberId} finished after another attempt ` +
              'had taken the row over; the outcome was audited and the status left alone.',
          );
        }

        await this.recordAudit(tx, command, claim, failure);

        const account = await tx.whatsappAccount.findUniqueOrThrow({
          where: { id: claim.whatsappAccountId },
          select: STATE_PROJECTION,
        });

        return toState(account);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private async recordAudit(
    tx: Prisma.TransactionClient,
    command: RegisterNumberCommand,
    claim: ClaimedRow,
    failure: RegistrationFailure | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action:
        failure === null
          ? AUDIT_ACTIONS.whatsappPhoneNumberRegistered
          : AUDIT_ACTIONS.whatsappPhoneNumberRegistrationFailed,
      targetType: 'whatsapp_account',
      targetId: claim.whatsappAccountId,
      metadata: {
        phoneNumberId: claim.phoneNumberId,
        wabaId: claim.wabaId,
        attempt: command.attempt,
        // Meta's numeric code and trace id, and nothing else it said: the
        // free-text message describes this app's grant and configuration, and
        // this table is exported for compliance review. **Never the PIN.**
        ...(failure === null
          ? {}
          : {
              reason: failure.reason,
              ...(failure.detail?.code == null ? {} : { metaCode: failure.detail.code }),
              ...(failure.detail?.traceId == null ? {} : { metaTraceId: failure.detail.traceId }),
            }),
      },
    });
  }
}

/** A row this attempt owns, with the PIN it will register. */
interface ClaimedRow {
  kind: 'claimed';
  whatsappAccountId: string;
  phoneNumberId: string;
  wabaId: string;
  pin: string;
  attemptedAt: Date;
}

type ClaimOutcome = ClaimedRow | { kind: 'settled'; state: NumberRegistrationState };

interface RegistrationFailure {
  reason: WhatsAppRegistrationFailureReason;
  detail: MetaErrorDetail | null;
}

/**
 * Which published reason a failed attempt carries. Identical on the first
 * attempt and on a retry, which is the property the whole two-caller shape
 * exists to hold.
 *
 * Every `MetaRequestRejectedError` lands on `rejected`, deliberately. Meta's
 * numeric codes for "already registered" and "PIN mismatch" are not asserted by
 * the contract this implements and have not been confirmed against a live app,
 * and an unmapped rejection recorded as `rejected` sends someone to the audit
 * row, where Meta's code and `fbtrace_id` are. Guessing `pin_rejected` would
 * send them to reset a PIN that was never the problem. `already_registered` is
 * still written — by the short-circuit in `claim`, from state this platform
 * holds rather than from a code it inferred.
 *
 * Anything that is not a Meta error at all is re-thrown: a bug in this service
 * is a fault, and recording it as a registration Meta refused would hide it.
 */
function failureOf(error: unknown): RegistrationFailure {
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

  throw error;
}

/**
 * Six digits from a CSPRNG, leading zeros kept.
 *
 * `randomInt` rather than `randomBytes(4) % 1_000_000`: the modulo is biased and
 * `randomInt` rejection-samples. The value stays a `string` end to end because
 * `000042` is a valid PIN and a number type would silently make it `42`.
 *
 * No weak-PIN filter. The value comes from a CSPRNG, is stored encrypted, and is
 * never typed by a human, so excluding `000000` and `123456` would only remove
 * entropy from a space Meta has already capped at a million.
 */
function generatePin(): string {
  return String(randomInt(0, PIN_UPPER_BOUND)).padStart(PIN_DIGITS, '0');
}

/** The row as the console reads it. The PIN column is not in this shape at all. */
function toState(account: {
  id: string;
  phoneNumberId: string;
  registrationStatus: WhatsAppRegistrationStatus;
  registrationFailureReason: string | null;
  registeredAt: Date | null;
  registrationAttemptedAt: Date | null;
}): NumberRegistrationState {
  return {
    whatsappAccountId: account.id,
    phoneNumberId: account.phoneNumberId,
    registrationStatus: account.registrationStatus,
    registrationFailureReason: toWhatsAppRegistrationFailureReason(
      account.registrationFailureReason,
    ),
    registeredAt: account.registeredAt,
    registrationAttemptedAt: account.registrationAttemptedAt,
  };
}
