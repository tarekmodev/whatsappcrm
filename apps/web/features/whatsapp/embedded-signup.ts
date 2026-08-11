import { MetaPhoneNumberIdSchema, MetaWabaIdSchema } from '@whatsappcrm/contracts';

/**
 * Everything this console knows about Meta's Embedded Signup JS SDK, in one
 * module: the script, the shape of `FB`, the `FB.login` arguments, and the
 * `postMessage` the flow reports itself through.
 *
 * Kept apart from the component so the two things worth testing — which origins
 * are trusted, and what a message parses to — are testable without a browser and
 * without Meta.
 *
 * ⚠️ The `FB.login` options and the message payload are Meta's to change, and
 * 0002 amendment 2 flags them as unverified on purpose. They follow Meta's
 * published Embedded Signup snippet; a change on Meta's side surfaces here and
 * nowhere else.
 */

/**
 * Meta's SDK, loaded on the WhatsApp settings page and nowhere else. `en_US` is
 * the SDK's own bundle name, not the console's locale — Meta hosts one build per
 * locale and this is the one their documentation names.
 */
export const META_SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';

/**
 * The origins an Embedded Signup message may arrive from.
 *
 * An exact allow-list, deliberately: Meta's own snippet tests
 * `origin.endsWith('facebook.com')`, which `evilfacebook.com` satisfies. This
 * message decides which WABA the console claims, so an origin check that a
 * look-alike domain passes is a way to have somebody else's WABA id submitted
 * under this session.
 */
const TRUSTED_MESSAGE_ORIGINS: readonly string[] = [
  'https://www.facebook.com',
  'https://web.facebook.com',
  'https://business.facebook.com',
];

/** The `type` every Embedded Signup message carries. */
const EMBEDDED_SIGNUP_MESSAGE_TYPE = 'WA_EMBEDDED_SIGNUP';

/**
 * The events that mean the run finished and an authorisation is coming.
 *
 * All three of the `FINISH` family are accepted, which is the open question 0002
 * left for this phase. `FINISH_ONLY_WABA` is a run that created a business
 * account without a usable number, and accepting it is the better answer than
 * refusing it in the browser: the API already ends that case with an authored,
 * actionable message — "add a phone number to it in Meta Business Manager, then
 * connect it again" — and a browser-side refusal would have to guess at the same
 * conclusion from less information.
 */
const COMPLETION_EVENTS: readonly string[] = [
  'FINISH',
  'FINISH_ONLY_WABA',
  'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
];

export const CANCEL_EVENT = 'CANCEL';
export const ERROR_EVENT = 'ERROR';

export interface EmbeddedSignupMessage {
  /** Meta's own event name, passed through so an unknown one can be ignored rather than guessed at. */
  readonly event: string;
  readonly isCompletion: boolean;
  /** `null` when Meta sent none, or one that is not a Meta id. */
  readonly wabaId: string | null;
  readonly phoneNumberId: string | null;
}

/**
 * Reads an Embedded Signup message, or `null` for anything else on the window.
 *
 * The page shares its `message` channel with every other frame and extension on
 * it, so this is a filter first and a parser second: wrong origin, wrong shape or
 * wrong `type` all answer `null` and the listener moves on.
 *
 * Meta sends the payload as a JSON *string*; a future SDK sending an object is
 * handled too, because tolerating both costs one branch and mis-reading a
 * finished run costs the user another trip through Meta.
 */
export function parseEmbeddedSignupMessage(message: MessageEvent): EmbeddedSignupMessage | null {
  if (!TRUSTED_MESSAGE_ORIGINS.includes(message.origin)) {
    return null;
  }

  const payload = toRecord(message.data);

  if (payload === null || payload.type !== EMBEDDED_SIGNUP_MESSAGE_TYPE) {
    return null;
  }

  const event = typeof payload.event === 'string' ? payload.event : '';
  const data = toRecord(payload.data) ?? {};

  return {
    event,
    isCompletion: COMPLETION_EVENTS.includes(event),
    wabaId: toMetaId(data.waba_id, MetaWabaIdSchema),
    phoneNumberId: toMetaId(data.phone_number_id, MetaPhoneNumberIdSchema),
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return toRecord(JSON.parse(value));
    } catch {
      // Not JSON, so not one of ours. Every page receives messages it did not ask
      // for; this is the common case, not an error worth reporting.
      return null;
    }
  }

  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** A subset of Zod's surface, so this module does not import Zod for one call. */
interface MetaIdParser {
  safeParse: (value: unknown) => { success: boolean };
}

/**
 * Validated rather than trusted. Meta's ids are digits, the contract says so, and
 * a value that fails here is dropped so the request is never sent with a `wabaId`
 * the API would reject after the code has already been spent.
 */
function toMetaId(value: unknown, parser: MetaIdParser): string | null {
  return typeof value === 'string' && parser.safeParse(value).success ? value : null;
}

// ---------------------------------------------------------------------------
// The SDK itself
// ---------------------------------------------------------------------------

export interface MetaLoginResponse {
  /** `null` when the person closed Meta's window or refused. */
  readonly authResponse: { readonly code?: string } | null;
  readonly status?: string;
}

export interface MetaSdk {
  init: (options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }) => void;
  login: (
    callback: (response: MetaLoginResponse) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: boolean;
      extras: Record<string, unknown>;
    },
  ) => void;
}

declare global {
  interface Window {
    FB?: MetaSdk;
  }
}

/**
 * The `FB.login` arguments the flow needs, and why each one is not a default.
 *
 * `response_type: 'code'` with `override_default_response_type: true` is what
 * makes Meta hand back an exchangeable code instead of a client-side access
 * token — the code is exchanged server-side with the app secret, which is the
 * whole reason no WhatsApp token ever exists in this browser.
 *
 * `sessionInfoVersion: '3'` is what makes the `postMessage` carry the structured
 * `{ waba_id, phone_number_id }` payload this console reads; without it the run
 * finishes and there is nothing to submit.
 */
export function embeddedSignupLoginOptions(configId: string): Parameters<MetaSdk['login']>[1] {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
  };
}
