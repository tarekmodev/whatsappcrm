import type { WhatsAppSignupFailureReason } from '@whatsappcrm/contracts';

/**
 * The failures this module produces, as typed domain errors rather than
 * `HttpException`s.
 *
 * The split is the same one `prisma.errors.ts` makes and for the same reason: a
 * service has no business choosing a status code, and the controller that
 * translates these is the only place that knows whether the caller is a platform
 * operator or a tenant agent. Anything not listed here reaches the caller as a
 * 500, which is the correct answer for a fault.
 *
 * **Nothing in this file ever carries an access token, or any part of one.** The
 * messages are read by operators and end up in logs; a credential in an error
 * message is a credential in a log aggregator.
 */

/**
 * Exported so a caller can ask "is this a WhatsApp configuration failure?"
 * without listing every subclass. TAR-20e's download job uses it to decide that
 * a missing or undecryptable credential is not worth a retry — the same
 * reasoning `MetaCloudApiError` is exported for.
 */
export abstract class WhatsAppError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Thrown when `WHATSAPP_TOKEN_ENCRYPTION_KEY` is absent.
 *
 * This is the fail-closed half of making the key optional: an environment that
 * was never given one refuses to connect a WABA and refuses to send, rather than
 * storing Meta's credential in clear text or reading a token it cannot decrypt.
 */
export class WhatsAppEncryptionUnavailableError extends WhatsAppError {
  constructor() {
    super(
      'The WhatsApp channel is disabled in this environment: WHATSAPP_TOKEN_ENCRYPTION_KEY is not ' +
        'configured, so a per-WABA access token can be neither stored nor read.',
    );
  }
}

/**
 * Thrown when a stored token cannot be decrypted — a payload from a key that has
 * since been rotated, a truncated column, or a tag that does not authenticate.
 *
 * Deliberately distinct from "no key configured": that one is a deployment gap
 * an operator fixes by setting a variable, this one means the stored ciphertext
 * and the configured key disagree and the token has to be re-supplied.
 */
export class WhatsAppTokenUndecryptableError extends WhatsAppError {
  constructor(readonly wabaId: string) {
    super(
      `The stored access token for WABA ${wabaId} could not be decrypted. Re-connect the business ` +
        'account to supply the token again; it may have been encrypted under a rotated key.',
    );
  }
}

/**
 * Thrown when a WABA that was expected to be connected is not — an id that names
 * nothing, or a row belonging to another tenant, which RLS makes indistinguishable
 * from absent and which TAR-39 requires stay that way.
 */
export class WhatsAppBusinessAccountNotFoundError extends WhatsAppError {
  constructor(readonly wabaId: string) {
    super(`No WhatsApp business account ${wabaId} is connected to this tenant.`);
  }
}

/** Thrown when a phone number id names nothing reachable by the tenant in scope. */
export class WhatsAppAccountNotFoundError extends WhatsAppError {
  constructor(readonly whatsappAccountId: string) {
    super(`No WhatsApp phone number ${whatsappAccountId} is connected to this tenant.`);
  }
}

/**
 * Thrown when a WABA row exists but holds no access token.
 *
 * Distinct from an undecryptable one: nothing was ever stored, so there is no
 * key rotation to investigate. It means the row was created by something other
 * than the connection endpoint — a fixture, a seed, a partial restore — and the
 * fix is to connect the business account properly rather than to look at keys.
 */
export class WhatsAppCredentialMissingError extends WhatsAppError {
  constructor(readonly wabaId: string) {
    super(
      `WhatsApp business account ${wabaId} has no stored access token. Connect it before sending ` +
        'or syncing templates.',
    );
  }
}

/**
 * Thrown when an Embedded Signup run could not be turned into a connected WABA
 * (TAR-168, 0002 amendment 2).
 *
 * `reason` is the published vocabulary the console branches on, and it is
 * nullable rather than exhaustive: two failures this orchestration can meet — a
 * WABA Meta reports no phone numbers for, and a number Meta reports in a form
 * that is not a phone number — are real, are the tenant's to act on, and are not
 * one of the four. `whatsAppSignupFailureReason` already answers `null` for a
 * reason a client does not recognise, so an envelope carrying no reason at all
 * lands on the same fallback rather than on a value that would mislead.
 *
 * **The message is authored here, per case, and is never Meta's.** It is read by
 * a tenant admin in a console: Meta's own text describes our app's grant and our
 * app's configuration, which is neither actionable to them nor ours to publish.
 * The underlying failure is logged where an operator can see it.
 */
export class WhatsAppSignupFailedError extends WhatsAppError {
  constructor(
    readonly reason: WhatsAppSignupFailureReason | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thrown when a WABA id or a phone number id is already held by **another**
 * tenant.
 *
 * Both columns are globally unique because one Meta app serves every tenant and
 * an id arriving on a webhook has to resolve to exactly one row (TAR-39, webhook
 * ingestion). So this is not a validation nicety: connecting a number a
 * neighbour already holds would either fail on the index or, worse, re-point
 * that neighbour's inbound traffic.
 *
 * The message names the id the operator supplied and nothing about the tenant
 * holding it — an admin-surface error must not become a way to enumerate other
 * customers' Meta assets.
 */
export class WhatsAppIdentityTakenError extends WhatsAppError {
  constructor(
    readonly kind: 'waba' | 'phone-number',
    readonly providerId: string,
  ) {
    super(
      kind === 'waba'
        ? `WhatsApp business account ${providerId} is already connected to a different tenant.`
        : `WhatsApp phone number ${providerId} is already connected to a different tenant.`,
    );
  }
}
