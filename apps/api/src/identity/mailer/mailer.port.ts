import type { MailerPort, OutboundEmail } from '@whatsappcrm/contracts';

/**
 * Injection token for the transactional-email adapter (TAR-53, `MailerPort`).
 *
 * The interface itself lives in `@whatsappcrm/contracts` because the templates
 * and their variables are part of the published auth contract; only the Nest
 * binding belongs here.
 *
 * Inject with
 * `@Inject(MAILER) private readonly mailer: MailerPort`.
 */
export const MAILER = Symbol('MAILER');

export type { MailerPort, OutboundEmail };

/**
 * Where the link in an email points, before the tenant's own hostname is put in
 * front of it.
 *
 * A path plus a token rather than a rendered URL, because the host is the one
 * part a service must not choose: it has to be the tenant's **primary** domain
 * resolved from the control plane, never the request `Host`, which an attacker
 * controls and could use to aim a genuine reset email at their own server
 * (TAR-53, link shapes). Assembling it is therefore the adapter's job, and
 * `data.linkPath` plus `data.token` is how a service asks for it.
 */
export const RESET_PASSWORD_LINK_PATH = '/reset-password';
