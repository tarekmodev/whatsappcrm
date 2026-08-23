'use server';

import { unstable_rethrow } from 'next/navigation';
import {
  AdminDomainParamsSchema,
  AdminTenantParamsSchema,
  AdminWebhookEventParamsSchema,
  type AdminWebhookEventReplayResponse,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { runAdminAction } from '@/lib/actions/run-admin-action';
import { toActionErrorResult } from '@/lib/actions/run-action';
import { clearPlatformCredential, storePlatformCredential } from '@/lib/admin/platform-credential';
import {
  activateTenantDomain,
  deactivateTenantDomain,
  reactivateTenant,
  replayWebhookEvent,
  suspendTenant,
  verifyPlatformCredential,
} from '@/lib/api/admin';
import type { ActionResult } from '@/lib/actions/result';
import { PlatformCredentialParser, SuspendTenantInputParser } from './action-input';

/**
 * Every write the platform-operator console makes, as the browser reaches them.
 *
 * All of them run through `runAdminAction`, whose gate is the credential rather
 * than a tenant permission — except the two that manage the credential itself,
 * which cannot require one they are in the business of setting or clearing.
 *
 * None of them returns the credential, or anything derived from it. A server
 * action's return value crosses to the browser.
 */

// ---------------------------------------------------------------------------
// The credential itself
// ---------------------------------------------------------------------------

/**
 * Takes a token, asks the API whether it is one, and stores it on success.
 *
 * The verification is the point: a console that stored whatever was typed would
 * let an operator through to a shell whose every section then failed, and the
 * screen that could have said "that token was not accepted" would be behind them.
 *
 * A rejection is an inline field error rather than a thrown failure — it is the
 * ordinary outcome of mistyping a secret. Anything that is *not* a rejection —
 * the API being unreachable — takes the error path, because telling an operator
 * their token is wrong when the API is down sends them looking in the wrong
 * place.
 *
 * The action does not redirect. Where the operator lands is `?next=`, which the
 * page has already narrowed to a path inside `/admin`, and doing it in the
 * component keeps the narrowing next to the value it narrows.
 */
export async function signInToPlatformConsoleAction(input: unknown): Promise<ActionResult<void>> {
  try {
    const parsed = PlatformCredentialParser.safeParse(input);

    if (!parsed.success) {
      return {
        status: 'error',
        message: content.platformAdmin.signIn.tokenRequiredError,
        requestId: null,
      };
    }

    if (!(await verifyPlatformCredential(parsed.data))) {
      return {
        status: 'error',
        message: content.platformAdmin.signIn.rejected,
        requestId: null,
      };
    }

    await storePlatformCredential(parsed.data);

    return { status: 'success', data: undefined };
  } catch (error) {
    unstable_rethrow(error);

    return toActionErrorResult(error, 'Platform admin sign-in');
  }
}

/**
 * Drops the credential.
 *
 * Deliberately *not* behind `runAdminAction`: signing out with a credential the
 * API has already rejected is the one thing an operator in that state needs to be
 * able to do, and a gate that redirected them to the form would leave the stale
 * cookie in place.
 *
 * There is no server-side session to end — the token is shared and outlives every
 * browser — so this is the whole of it. Rotating `PLATFORM_ADMIN_TOKEN` is what
 * revokes a credential, and `platform-admin.guard.ts` says so.
 */
export async function signOutOfPlatformConsoleAction(): Promise<ActionResult<void>> {
  await clearPlatformCredential();

  return { status: 'success', data: undefined };
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export async function suspendTenantAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: SuspendTenantInputParser,
    input,
    perform: async ({ slug, reason }) => {
      await suspendTenant(slug, reason);

      // The slug back, so the toast can name what was suspended without the
      // dialog holding a second copy of the value it submitted.
      return slug;
    },
    // The page it revalidates is the one whose trail has just grown a row, not
    // the lookup screen: suspension writes a lifecycle event, and the status
    // chip above it is read from that row.
    revalidate: ({ slug }) => routes.adminTenant(slug),
    label: 'Suspend tenant',
  });
}

export async function reactivateTenantAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: AdminTenantParamsSchema,
    input,
    perform: async ({ slug }) => {
      await reactivateTenant(slug);

      return slug;
    },
    revalidate: ({ slug }) => routes.adminTenant(slug),
    label: 'Reactivate tenant',
  });
}

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

export async function activateTenantDomainAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: AdminDomainParamsSchema,
    input,
    perform: async ({ slug, hostname }) => {
      await activateTenantDomain(slug, hostname);

      return hostname;
    },
    revalidate: routes.adminDomains(),
    label: 'Activate tenant domain',
  });
}

export async function deactivateTenantDomainAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: AdminDomainParamsSchema,
    input,
    perform: async ({ slug, hostname }) => {
      await deactivateTenantDomain(slug, hostname);

      return hostname;
    },
    revalidate: routes.adminDomains(),
    label: 'Deactivate tenant domain',
  });
}

// ---------------------------------------------------------------------------
// Parked webhook events
// ---------------------------------------------------------------------------

/**
 * Resets one parked event. Nothing to revalidate: the screen holds no server-read
 * list — there is no endpoint to list parked events — so the result the operator
 * needs is the response, which this returns.
 */
export async function replayWebhookEventAction(
  input: unknown,
): Promise<ActionResult<AdminWebhookEventReplayResponse>> {
  return runAdminAction({
    parser: AdminWebhookEventParamsSchema,
    input,
    perform: async ({ webhookEventId }) => await replayWebhookEvent(webhookEventId),
    revalidate: null,
    label: 'Replay webhook event',
  });
}
