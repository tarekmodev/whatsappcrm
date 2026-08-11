/**
 * Typed failures the webhook surface raises, so the controller maps a cause to a
 * status once rather than interpreting strings.
 *
 * All of them answer the caller identically — the route is public and
 * unauthenticated, and telling an anonymous caller *why* it was refused is how a
 * misconfiguration becomes a probe. The distinction exists for the log line and
 * for the tests, not for the response body.
 */

/** Base class, so `catch` can narrow to "a webhook refusal" in one check. */
export abstract class WebhookRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `X-Hub-Signature-256` was absent, malformed, or did not match the raw body. */
export class WebhookSignatureInvalidError extends WebhookRefusedError {
  constructor() {
    super('The X-Hub-Signature-256 header does not match the request body.');
  }
}

/**
 * The environment holds no `WHATSAPP_APP_SECRET` or no
 * `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
 *
 * Fails closed and looks identical from outside a signature mismatch: an
 * environment that was never given the secret must not accept unsigned
 * payloads, and must not advertise that it is unconfigured either.
 */
export class WebhookChannelNotConfiguredError extends WebhookRefusedError {
  constructor(variable: string) {
    super(`${variable} is not configured; the WhatsApp webhook route is refusing every request.`);
  }
}
