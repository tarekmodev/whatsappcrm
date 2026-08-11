'use server';

import { unstable_rethrow } from 'next/navigation';
import {
  WhatsAppEmbeddedSignupInputSchema,
  type ConnectedWhatsAppBusinessAccountResponse,
} from '@whatsappcrm/contracts';
import { connectWhatsAppBusinessAccount } from '@/lib/api/whatsapp';
import { assertPermission, PermissionDeniedError } from '@/lib/session/session';
import {
  connectFailure,
  connectFailureFromError,
  type WhatsAppConnectFailureReport,
} from './connect-failure';

/**
 * Connecting a WABA from the console, as the browser reaches it.
 *
 * Like every other mutation in this app it is a server action: `lib/api` is
 * `server-only` because it carries the session cookie forward, and the three
 * calls that bypass it are the ones whose `Set-Cookie` has to land in the user's
 * browser. This one has no cookie to set. It costs no extra hop either — the
 * browser's `/api/*` path is proxied by this same process (`next.config.mjs`), so
 * both routes are browser → Next → API.
 *
 * **Nothing between the click and this call may block.** Meta's authorisation
 * code is single-use and lives about 30 seconds, so there is no confirmation
 * step, no form to fill in and no navigation on the way here — the panel calls
 * this the instant it holds both halves of Meta's answer.
 *
 * It returns a discriminated result rather than throwing, for the reason
 * `ActionResult` documents: a thrown action unmounts into the route's error
 * boundary, and this failure has to render *in place*, next to a button the user
 * can press again. It does not reuse `ActionResult` because that type carries a
 * message, and this flow branches on a reason instead — the whole point of the
 * published taxonomy.
 */
export type ConnectWhatsAppAccountResult =
  | { readonly status: 'success'; readonly account: ConnectedWhatsAppBusinessAccountResponse }
  | { readonly status: 'error'; readonly report: WhatsAppConnectFailureReport };

export async function connectWhatsAppAccountAction(
  input: unknown,
): Promise<ConnectWhatsAppAccountResult> {
  try {
    // A server action is a public endpoint, so the permission is asserted here
    // and not inferred from the page that rendered the button. Defence in depth:
    // the API refuses the same call regardless.
    await assertPermission('channel:manage');

    // The contract's own schema, so the console and the API cannot disagree about
    // what a valid body is.
    const parsed = WhatsAppEmbeddedSignupInputSchema.safeParse(input);

    if (!parsed.success) {
      // Meta gave the browser something this contract does not accept. Nothing
      // the user can act on differently, so it reads as an unexplained failure —
      // and it is logged below the same way, because it means one of the two
      // sides changed shape.
      console.error('Embedded Signup produced a body the contract rejects');

      return { status: 'error', report: connectFailure('unknown') };
    }

    return { status: 'success', account: await connectWhatsAppBusinessAccount(parsed.data) };
  } catch (error) {
    return { status: 'error', report: toFailureReport(error) };
  }
}

function toFailureReport(error: unknown): WhatsAppConnectFailureReport {
  // First, before anything else inspects it: the session guard answers a lost
  // session with a `redirect`, which Next implements by throwing. Caught and
  // mapped, that navigation would be swallowed and the user would sit on a page
  // they are no longer signed in to.
  unstable_rethrow(error);

  if (error instanceof PermissionDeniedError) {
    return connectFailure('forbidden');
  }

  const report = connectFailureFromError(error);

  if (report.failure === 'unknown') {
    // Never swallowed: the server log keeps the detail the user must not see.
    // Deliberately logs the error and not the request body — that body carries
    // Meta's code, and no line in this codebase writes one down.
    console.error('Connecting a WhatsApp Business Account failed', error);
  }

  return report;
}
