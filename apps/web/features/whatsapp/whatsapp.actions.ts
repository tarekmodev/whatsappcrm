'use server';

import { unstable_rethrow } from 'next/navigation';
import {
  CONVERSATION_SORT_DEFAULT,
  WhatsAppEmbeddedSignupInputSchema,
  WhatsAppPhoneNumberParamsSchema,
  type ConnectedWhatsAppBusinessAccountResponse,
  type WhatsAppPhoneNumberRegistrationResponse,
} from '@whatsappcrm/contracts';
import { listConversations } from '@/lib/api/conversations';
import { connectWhatsAppBusinessAccount, registerWhatsAppPhoneNumber } from '@/lib/api/whatsapp';
import { runAction } from '@/lib/actions/run-action';
import { assertPermission, PermissionDeniedError } from '@/lib/session/session';
import type { ActionResult } from '@/lib/actions/result';
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

/**
 * Registering the connected number for sending — the wizard's third step
 * (TAR-814, over TAR-170's route).
 *
 * `runAction` rather than the hand-rolled sequence above, because this one is an
 * ordinary mutation: there is no single-use code to race, so it can afford the
 * assert-validate-perform-map shape every other action in the app uses.
 * `revalidate` is `null` — the wizard is a client island with no server render
 * to invalidate, and re-rendering the settings route behind it would change
 * nothing on screen.
 *
 * **A refused registration comes back as `success`.** The route answers `200`
 * with the outcome in `registrationFailureReason`, so the reason is data the
 * step renders and not an error the action swallows; only a genuine 4xx/5xx —
 * an id naming nothing, a lost permission, a deactivated tenant — takes the
 * error arm.
 */
export async function registerWhatsAppNumberAction(
  input: unknown,
): Promise<ActionResult<WhatsAppPhoneNumberRegistrationResponse>> {
  return runAction({
    permission: 'channel:manage',
    parser: WhatsAppPhoneNumberParamsSchema,
    input,
    perform: ({ whatsappAccountId }) => registerWhatsAppPhoneNumber(whatsappAccountId),
    revalidate: null,
    label: 'WhatsApp number registration',
  });
}

/**
 * Whether anything has reached the connected number yet — the wizard's fourth
 * step.
 *
 * ## Why this is a read of the inbox and not a send
 *
 * TAR-814 asks the wizard to prove the round trip without adding a backend
 * route, and there is no route that could send one: `POST
 * /v1/conversations/{id}/messages` is addressed to a **conversation**, and a
 * conversation exists only once a customer has written in. Cloud API is built
 * that way — a business cannot open a thread with free-form text, only with an
 * approved template, and a freshly connected WABA has none. So the honest test
 * is the direction that works: the reader messages their own number from
 * WhatsApp, and this looks for the thread it created.
 *
 * A thread on that number proves the whole chain end to end — Meta's webhook
 * reached us, the routing key resolved, the tenant scoping held — which is more
 * than a send would have proved. Replying to it is then one press in the inbox,
 * inside the service window the inbound message just opened.
 *
 * ## `conversation:read`, and one page
 *
 * The narrower of the two inbox permissions, because that is what this needs; a
 * principal holding `channel:manage` is an admin and holds both. `scope: 'all'`
 * is silently narrowed by the API for anyone without `conversation:read_all`,
 * which is the correct degradation — a narrower view can still contain the
 * thread.
 *
 * One page of the newest threads and no paging. The message being looked for was
 * sent seconds ago, so it is at the front by construction; walking the whole
 * inbox to find an older one would answer a question nobody asked.
 */
export async function findWhatsAppInboundAction(
  input: unknown,
): Promise<ActionResult<{ readonly hasInbound: boolean }>> {
  return runAction({
    permission: 'conversation:read',
    parser: WhatsAppPhoneNumberParamsSchema,
    input,
    perform: async ({ whatsappAccountId }) => {
      const page = await listConversations({
        scope: 'all',
        limit: INBOUND_CHECK_PAGE_SIZE,
        sort: CONVERSATION_SORT_DEFAULT,
      });

      return {
        hasInbound: page.items.some(
          (conversation) => conversation.whatsappAccountId === whatsappAccountId,
        ),
      };
    },
    revalidate: null,
    label: 'WhatsApp inbound check',
  });
}

/** The newest threads. Enough to find one sent moments ago, and no more. */
const INBOUND_CHECK_PAGE_SIZE = 25;
