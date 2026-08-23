import { Injectable, Logger } from '@nestjs/common';
import { PhoneE164Schema, type WhatsAppRegistrationFailureReason } from '@whatsappcrm/contracts';
import {
  WhatsAppBusinessAccountConnectionService,
  type ConnectBusinessAccountResult,
  type ConnectPhoneNumberCommand,
} from './business-account-connection.service';
import { MetaCloudApiClient, type MetaPhoneNumber } from './meta-cloud-api.client';
import { MetaAuthenticationError, MetaRequestRejectedError } from './meta-cloud-api.errors';
import {
  WhatsAppPhoneNumberRegistrationService,
  type NumberRegistrationState,
} from './phone-number-registration.service';
import { WhatsAppSignupFailedError } from './whatsapp.errors';

/**
 * Meta's OAuth sub-code for a code that outlived its ~30-second window. A spent
 * code (36009) and a malformed one arrive as rejections too, and are
 * `code_invalid`: only this one tells the console "you were too slow", which is
 * the one case where re-running the flow faster is the fix.
 */
const CODE_EXPIRED_SUBCODE = 36007;

/**
 * The two registration failures that say "Meta is not answering us right now"
 * rather than "Meta refused this number". Continuing past either spends the rest
 * of the request on calls that will fail the same way.
 */
const STOPS_THE_LOOP: ReadonlySet<WhatsAppRegistrationFailureReason> = new Set([
  'rate_limited',
  'upstream_unavailable',
]);

/**
 * Which Meta call failed, which is what decides the published reason. Every
 * value maps to exactly one reason, and that mapping is `reasonFor` below.
 */
type SignupStage = 'exchange' | 'read-back' | 'phone-numbers' | 'subscribe';

export interface ConnectViaEmbeddedSignupCommand {
  /** Meta's exchangeable token code. Single-use, ~30 seconds. Never logged. */
  code: string;
  /** What the browser says was granted. An assertion, verified below. */
  wabaId: string;
}

/**
 * Turns a completed Embedded Signup run into a connected WABA (TAR-168, 0002
 * amendment 2).
 *
 * ## The order is the guarantee
 *
 * Exchange the code, read the WABA back with the token it produced, list that
 * WABA's numbers, subscribe this app to its webhooks — and only then open the
 * transaction. Every Meta call that can fail the connection happens **before**
 * `WhatsAppBusinessAccountConnectionService.connect()` is entered, so a failure
 * at any of them leaves no WABA row and no stored credential to clean up: there
 * was never a transaction to leave one in.
 *
 * Registration is the one exception, and it is on the other side of the
 * transaction for a reason `registerForSending` sets out below: it is the only
 * call that sends Meta a credential this platform invented, so that credential
 * has to be durable before it goes. It also cannot fail the connection, which is
 * what keeps the "before the transaction" rule meaningful for everything else.
 *
 * `connect()` itself is untouched by this path. Its advisory lock, its
 * encryption, its audit row and its idempotency on `wabaId` are the same ones
 * the operator route drives, which is what makes the two paths produce the same
 * row. The actor differs, and it differs without this service saying so:
 * `AuditService` reads it from the request scope, so a tenant admin's connection
 * is attributed to them by the same code that attributes an operator's to a
 * credential label.
 *
 * ## Nothing is deferred, and nothing is retried
 *
 * The code lives about 30 seconds, so the exchange is synchronous inside the
 * request — a job that picks it up two seconds later is a job that sometimes
 * picks it up thirty-one seconds later. Nothing here retries either: a spent
 * code does not come back, and the retry unit is the *flow*, which the console
 * re-runs for a fresh one.
 *
 * ## What it trusts
 *
 * The `wabaId` in the request body is an assertion by the browser, and the
 * browser is not an authority on which WABA a token covers. It is checked
 * against what the new token can actually read, and everything stored — the
 * name, the verification status, the numbers, their display forms — comes from
 * Meta's answers rather than from the request.
 *
 * **Nothing here logs the code, the token, or any part of either.** The log
 * lines carry the WABA id and Meta's own failure description.
 */
@Injectable()
export class WhatsAppEmbeddedSignupService {
  private readonly logger = new Logger(WhatsAppEmbeddedSignupService.name);

  constructor(
    private readonly meta: MetaCloudApiClient,
    private readonly connection: WhatsAppBusinessAccountConnectionService,
    private readonly registration: WhatsAppPhoneNumberRegistrationService,
  ) {}

  async connect(command: ConnectViaEmbeddedSignupCommand): Promise<ConnectBusinessAccountResult> {
    const token = await this.meta
      .exchangeSignupCode({ code: command.code })
      .catch((error: unknown) => this.reportFailure('exchange', command.wabaId, error));

    if (token.expiresInSeconds !== null) {
      // `whatsapp_business_accounts` has no `token_expires_at` and the send path
      // assumes a credential that keeps working. Meta stating an expiry is the
      // signal that assumption has stopped holding — logged rather than
      // absorbed, because the fix is a column and a refresh path, not a branch
      // here (0002, amendment 2: flag it rather than assuming).
      this.logger.warn(
        `Meta issued a business token for WABA ${command.wabaId} that expires in ` +
          `${token.expiresInSeconds}s. The schema stores no expiry and the send path assumes none.`,
      );
    }

    const account = await this.meta
      .describeBusinessAccount({ wabaId: command.wabaId, accessToken: token.accessToken })
      .catch((error: unknown) => this.reportFailure('read-back', command.wabaId, error));

    if (account.wabaId !== command.wabaId) {
      // Meta answering about a different WABA than the one asked for. Belt and
      // braces next to the rejection Meta normally returns, and the cheaper of
      // the two to be wrong about: this is the assertion the whole read-back
      // exists to check.
      throw signupFailed('waba_mismatch');
    }

    const numbers = await this.meta
      .listPhoneNumbers({ wabaId: command.wabaId, accessToken: token.accessToken })
      .catch((error: unknown) => this.reportFailure('phone-numbers', command.wabaId, error));

    if (numbers.hasMore) {
      // The page is capped at the same 20 the connection input allows, so a
      // larger WABA connects its first page. Said out loud rather than
      // truncated silently: a tenant whose twenty-first number never appears
      // needs somebody to be able to find out why.
      this.logger.warn(
        `WABA ${command.wabaId} holds more phone numbers than one page returns; ` +
          `connecting the ${numbers.phoneNumbers.length} Meta listed first.`,
      );
    }

    const phoneNumbers = numbers.phoneNumbers.map(toPhoneNumberCommand);

    if (phoneNumbers.length === 0) {
      throw new WhatsAppSignupFailedError(
        null,
        'Meta reports no usable phone number on this WhatsApp Business Account. Add a phone ' +
          'number to it in Meta Business Manager, then connect it again.',
      );
    }

    // Last of the Meta calls, and still before the transaction. Without it Meta
    // accepts the WABA, the token works, and not one inbound message is ever
    // delivered: the row looks healthy while the inbox stays empty. In
    // self-service there is nobody standing in Meta's UI to do it by hand.
    await this.meta
      .subscribeApp({ wabaId: command.wabaId, accessToken: token.accessToken })
      .catch((error: unknown) => this.reportFailure('subscribe', command.wabaId, error));

    // From here on the request is a connection like any other, and the service
    // that owns it does not learn that a signup produced it.
    const connected = await this.connection.connect({
      wabaId: account.wabaId,
      name: account.name ?? undefined,
      accessToken: token.accessToken,
      verificationStatus: account.verificationStatus ?? undefined,
      phoneNumbers,
    });

    return this.registerForSending(connected, token.accessToken);
  }

  /**
   * Registers every number this connection attached, so a tenant who has just
   * finished Embedded Signup can send without doing anything else (TAR-170,
   * 0002 amendment 12).
   *
   * ## Why this one Meta call is after the transaction
   *
   * Every other call in this flow happens before `connect()` precisely so a
   * failure leaves no row and no stored credential. Registration cannot follow
   * that rule, because it sends a credential this platform *invents*: if it
   * succeeded and the commit then failed, Meta would hold a PIN nobody else has,
   * and the number would be registered under a secret this platform cannot
   * reproduce. So the PIN has to be durable before it reaches Meta, which puts
   * this call on the other side of the transaction from all the others.
   *
   * It is not in a queue either. The tenant is standing in the console watching
   * the connection complete, and being able to see the outcome is the entire
   * point of the status field.
   *
   * ## Registration never fails the request
   *
   * The connection succeeded. A number that could not be registered can still
   * receive, and the tenant keeps a working inbound channel with "sending
   * unavailable" against the number and a reason they can act on — which is a
   * far better answer than discarding the connection over a failure that is
   * usually transient and always retryable. Nothing thrown below reaches the
   * caller.
   *
   * ## Why a throttle or an outage stops the loop
   *
   * Both mean Meta is not answering right now, so continuing spends what is left
   * of the request on calls that will fail identically. Numbers not reached stay
   * `unregistered` and are retryable from the console. A per-number refusal is
   * different — Meta answered, quickly, about that number — so the loop carries
   * on. The list is already bounded at 20 by the connection input schema.
   */
  private async registerForSending(
    connected: ConnectBusinessAccountResult,
    accessToken: string,
  ): Promise<ConnectBusinessAccountResult> {
    const states = new Map<string, NumberRegistrationState>();

    for (const number of connected.businessAccount.accounts) {
      const state = await this.registerOne(number.id, number.phoneNumberId, accessToken);

      if (state === null) {
        break;
      }

      states.set(number.id, state);

      if (
        state.registrationFailureReason !== null &&
        STOPS_THE_LOOP.has(state.registrationFailureReason)
      ) {
        this.logger.warn(
          `Registration stopped after phone number ${number.phoneNumberId} reported ` +
            `${state.registrationFailureReason}; the remaining numbers stay unregistered and are ` +
            'retryable.',
        );
        break;
      }
    }

    return {
      ...connected,
      businessAccount: {
        ...connected.businessAccount,
        accounts: connected.businessAccount.accounts.map((number) => {
          const state = states.get(number.id);

          return state === undefined
            ? number
            : {
                ...number,
                registrationStatus: state.registrationStatus,
                registrationFailureReason: state.registrationFailureReason,
                registeredAt: state.registeredAt,
                registrationAttemptedAt: state.registrationAttemptedAt,
              };
        }),
      },
    };
  }

  /**
   * `null` when the attempt could not be made at all — a database failure, or a
   * fault in the registration service.
   *
   * Swallowed rather than propagated for the reason above: the connection has
   * committed, and turning a successful signup into a 500 would tell the tenant
   * their WABA is not connected when it is. It is logged at `warn` with the
   * number it concerns, which is what an operator needs to find it; the number
   * stays `unregistered` and the retry route is how it is picked up.
   *
   * **The error's class is logged, not its message.** The statement this can
   * fail on is the one that writes `registration_pin_encrypted`, and a Prisma
   * validation error quotes the arguments it refused — so interpolating the
   * message here is a path for credential material to reach a log line. The
   * class plus the phone number id is what an operator acts on; the error itself
   * is re-thrown by nothing and reproduced from the retry route.
   */
  private async registerOne(
    whatsappAccountId: string,
    phoneNumberId: string,
    accessToken: string,
  ): Promise<NumberRegistrationState | null> {
    return this.registration
      .register({ whatsappAccountId, accessToken, attempt: 'initial' })
      .catch((error: unknown) => {
        this.logger.warn(
          `Registering phone number ${phoneNumberId} for sending could not be attempted: ` +
            `${error instanceof Error ? error.name : 'an unknown failure'}. The number stays ` +
            'unregistered and is retryable.',
        );

        return null;
      });
  }

  /**
   * Logs what Meta actually said and re-throws the tenant-facing failure.
   *
   * The two are deliberately different texts. Meta's message describes *our*
   * app's grant and *our* app's configuration — `META_APP_ID is not set` is the
   * clearest example — and a tenant admin can act on none of it. So the console
   * gets an authored message plus the reason it branches on, and the operator
   * gets Meta's own words in the log.
   *
   * Throttling and outages are re-thrown untouched: `rate_limited` and
   * `upstream_unavailable` already say "later" rather than "no", and folding
   * them into `whatsapp_signup_failed` would tell a tenant to grant a permission
   * they have already granted.
   */
  private reportFailure(stage: SignupStage, wabaId: string, error: unknown): never {
    if (!(error instanceof MetaAuthenticationError || error instanceof MetaRequestRejectedError)) {
      throw error;
    }

    const reason = reasonFor(stage, error);

    this.logger.warn(
      `Embedded Signup for WABA ${wabaId} failed at the ${stage} step as ${reason}: ` +
        `${error.detail?.message ?? error.message}`,
    );

    throw signupFailed(reason);
  }
}

/**
 * Which published reason a rejected Meta call carries.
 *
 * The stage decides it, because the same `MetaRequestRejectedError` means
 * different things at different points of the flow: at the exchange it is about
 * the code, at the read-back it is about which WABA the grant covers, and after
 * that it is about what the grant lets us do with it.
 *
 * The exchange refusing before it reaches Meta — `META_APP_ID` or
 * `WHATSAPP_APP_SECRET` absent, which the client reports with `status` 0 — lands
 * on `insufficient_permissions` with the rest. That is the ruled fail-closed
 * default rather than a misclassification: nothing was granted to us that we can
 * act on, and reporting a configuration gap to a tenant tells the one party who
 * cannot fix it (0002, amendment 2).
 */
function reasonFor(
  stage: SignupStage,
  error: MetaAuthenticationError | MetaRequestRejectedError,
): 'code_expired' | 'code_invalid' | 'insufficient_permissions' | 'waba_mismatch' {
  if (stage === 'read-back') {
    return 'waba_mismatch';
  }

  if (stage !== 'exchange' || error instanceof MetaAuthenticationError) {
    return 'insufficient_permissions';
  }

  if (error.status === 0) {
    return 'insufficient_permissions';
  }

  return error.detail?.subcode === CODE_EXPIRED_SUBCODE ? 'code_expired' : 'code_invalid';
}

/** The message a tenant admin reads, per reason. Authored, never Meta's. */
const SIGNUP_FAILURE_MESSAGES = {
  code_expired:
    'The WhatsApp connection took too long to complete. Meta’s authorization code is valid for ' +
    'about 30 seconds — start the connection again.',
  code_invalid:
    'Meta rejected this WhatsApp authorization. Start the connection again to obtain a fresh one.',
  insufficient_permissions:
    'This WhatsApp connection was not granted the permissions it needs. Start it again and accept ' +
    'every permission Meta asks for.',
  waba_mismatch:
    'The WhatsApp Business Account named by this connection could not be read with the access it ' +
    'was granted. Please contact support.',
} as const;

function signupFailed(reason: keyof typeof SIGNUP_FAILURE_MESSAGES): WhatsAppSignupFailedError {
  return new WhatsAppSignupFailedError(reason, SIGNUP_FAILURE_MESSAGES[reason]);
}

/**
 * One of Meta's numbers, as the connection needs it.
 *
 * `display_phone_number` arrives formatted for people — `+966 50 123 4567` — and
 * the contract publishes E.164, so the separators come out. A number that does
 * not survive that is dropped rather than stored: `PhoneE164Schema` is what the
 * response promises, and a row that cannot satisfy it is a broken response on
 * every future read, not just on this one.
 */
function toPhoneNumberCommand(number: MetaPhoneNumber): ConnectPhoneNumberCommand {
  const e164 = `+${number.displayPhoneNumber.replace(/\D/g, '')}`;

  if (!PhoneE164Schema.safeParse(e164).success) {
    throw new WhatsAppSignupFailedError(
      null,
      `Meta reported phone number ${number.phoneNumberId} in a form this platform cannot store. ` +
        'Please contact support.',
    );
  }

  return {
    phoneNumberId: number.phoneNumberId,
    displayPhoneNumber: e164,
    ...(number.verifiedName === null ? {} : { verifiedName: number.verifiedName }),
    ...(number.qualityRating === null ? {} : { qualityRating: number.qualityRating }),
  };
}
