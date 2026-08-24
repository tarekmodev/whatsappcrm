'use server';

import {
  AdminTenantParamsSchema,
  ProvisionTenantInputSchema,
  type AdminTenantLifecycleResponse,
} from '@whatsappcrm/contracts';
import type { ActionResult } from '@/lib/actions/result';
import { runAdminAction } from '~/lib/actions/run-admin-action';
import { routes } from '~/lib/routes';
import {
  cancelTenant,
  deleteTenant,
  provisionTenant,
  reactivateTenant,
  suspendTenant,
  type ProvisionOutcome,
} from '~/lib/api/admin';
import { CancelInputParser, DeleteInputParser, SuspendInputParser } from './action-input';

/**
 * The five tenant writes, as the browser reaches them (spec §2.5).
 *
 * All of them go through `runAdminAction`, whose gate is the credential rather
 * than a tenant permission. Each returns what its dialog needs to name the
 * subject in a toast without holding a second copy of the value it submitted.
 *
 * The four that name an existing tenant revalidate that tenant's screen: each
 * writes a lifecycle row, and the status the screen shows is read from it.
 */

/**
 * Provisioning is the one write that is a **form** rather than a confirmation,
 * and the one whose *status code* is part of the answer.
 *
 * `201` created the tenant; `200` means one already existed at that slug and
 * nothing changed. The dialog renders those differently — treating the idempotent
 * replay as a success is how an operator concludes they created something they
 * did not — so the outcome carries `created` rather than discarding it.
 *
 * It revalidates nothing: there is no tenant list for a new tenant to appear in,
 * which is the gap this whole console is shaped around. The dialog navigates to
 * the new tenant instead.
 */
export async function provisionTenantAction(
  input: unknown,
): Promise<ActionResult<ProvisionOutcome>> {
  return runAdminAction({
    parser: ProvisionTenantInputSchema,
    input,
    perform: provisionTenant,
    revalidate: null,
    label: 'Provision tenant',
  });
}

export async function suspendTenantAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: SuspendInputParser,
    input,
    perform: async ({ slug, reason }) => {
      await suspendTenant(slug, reason);

      return slug;
    },
    revalidate: ({ slug }) => routes.tenant(slug),
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
    revalidate: ({ slug }) => routes.tenant(slug),
    label: 'Reactivate tenant',
  });
}

export async function cancelTenantAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: CancelInputParser,
    input,
    perform: async ({ slug, reason }) => {
      await cancelTenant(slug, reason);

      return slug;
    },
    revalidate: ({ slug }) => routes.tenant(slug),
    label: 'Cancel tenant subscription',
  });
}

/**
 * Schedules a deletion, or forces one.
 *
 * The two modes are one route and one action; which of them ran is what the
 * dialog's toast has to say, so the outcome carries `force` back rather than the
 * caller remembering what it sent.
 */
export interface DeleteOutcome {
  readonly slug: string;
  readonly force: boolean;
  readonly state: AdminTenantLifecycleResponse;
}

export async function deleteTenantAction(input: unknown): Promise<ActionResult<DeleteOutcome>> {
  return runAdminAction({
    parser: DeleteInputParser,
    input,
    perform: async ({ slug, force, reason }) => ({
      slug,
      force,
      state: await deleteTenant(slug, { force, reason }),
    }),
    revalidate: ({ slug }) => routes.tenant(slug),
    label: 'Delete tenant',
  });
}
