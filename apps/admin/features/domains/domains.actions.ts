'use server';

import { AdminDomainParamsSchema } from '@whatsappcrm/contracts';
import type { ActionResult } from '@/lib/actions/result';
import { runAdminAction } from '~/lib/actions/run-admin-action';
import { routes } from '~/lib/routes';
import { attachDomain, detachDomain } from '~/lib/api/admin';

/**
 * The two domain-queue writes. Both revalidate the queue: the row moves to the
 * other half when either succeeds, so the list the operator is looking at is
 * stale the moment it returns.
 */
export async function attachDomainAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: AdminDomainParamsSchema,
    input,
    perform: async ({ slug, hostname }) => {
      await attachDomain(slug, hostname);

      return hostname;
    },
    revalidate: routes.domains(),
    label: 'Attach tenant domain',
  });
}

export async function detachDomainAction(input: unknown): Promise<ActionResult<string>> {
  return runAdminAction({
    parser: AdminDomainParamsSchema,
    input,
    perform: async ({ slug, hostname }) => {
      await detachDomain(slug, hostname);

      return hostname;
    },
    revalidate: routes.domains(),
    label: 'Detach tenant domain',
  });
}
