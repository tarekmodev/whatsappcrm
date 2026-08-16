'use server';

import { TenantUpdateInputSchema, type TenantResponse } from '@whatsappcrm/contracts';
import { updateTenant } from '@/lib/api/tenant';
import { runAction } from '@/lib/actions/run-action';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';

/**
 * Saving the workspace profile.
 *
 * Gated on `branding:write`, which is the permission ADR 0002's endpoint table
 * assigns to `PATCH /api/v1/tenant` — not `tenant:settings`, which reads the
 * lifecycle. Asserted here as well as in the page, because a server action is a
 * public endpoint and navigation gating is not a gate.
 *
 * The input is the contract's own schema, so the console and the API cannot
 * disagree about what a valid body is; `TenantUpdateInputSchema` is partial
 * throughout, which is what lets this send `{ name, branding: { supportEmail } }`
 * without the form having to round-trip colours it never showed.
 */
export async function updateWorkspaceProfileAction(
  input: unknown,
): Promise<ActionResult<TenantResponse>> {
  return runAction({
    permission: 'branding:write',
    parser: TenantUpdateInputSchema,
    input,
    perform: updateTenant,
    revalidate: routes.settingsWorkspace(),
    label: 'Update workspace profile',
  });
}
