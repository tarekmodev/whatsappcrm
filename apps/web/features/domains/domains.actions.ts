'use server';

import { IdSchema, TenantDomainCreateInputSchema, type TenantDomain } from '@whatsappcrm/contracts';
import { routes } from '@/lib/routes';
import { runAction } from '@/lib/actions/run-action';
import {
  createTenantDomain,
  deleteTenantDomain,
  setPrimaryTenantDomain,
  verifyTenantDomain,
} from '@/lib/api/tenant';
import type { ActionResult } from '@/lib/actions/result';

/**
 * The four domain mutations, as the browser reaches them.
 *
 * All gated on `domain:write` rather than `branding:write`: DNS control decides
 * where every invite and password-reset link in the tenant is sent, and that is
 * not the same authority as choosing a colour.
 *
 * Each revalidates the domains page. Unlike branding, none of this is rendered by
 * the root layout — a domain change moves what the tenant *is reachable on*, not
 * what any current page looks like — so re-rendering the whole app would be
 * churn for nothing.
 */

export async function addDomainAction(input: unknown): Promise<ActionResult<TenantDomain>> {
  return runAction({
    permission: 'domain:write',
    parser: TenantDomainCreateInputSchema,
    input,
    perform: createTenantDomain,
    revalidate: DOMAINS_PATH,
    label: 'Add domain',
  });
}

/**
 * `POST /domains/{id}/verify`.
 *
 * A failed check comes back as **success with an unverified domain**, not as an
 * error: nothing went wrong with the request, and "the TXT record is not visible
 * yet" is a state on the resource. The caller reads
 * `verification.lastFailureReason` off the row and says so in place. Only a real
 * failure — no permission, the domain is gone, the API is down — takes the error
 * branch.
 */
export async function verifyDomainAction(input: unknown): Promise<ActionResult<TenantDomain>> {
  return runAction({
    permission: 'domain:write',
    parser: IdSchema,
    input,
    perform: verifyTenantDomain,
    revalidate: DOMAINS_PATH,
    label: 'Verify domain',
  });
}

export async function setPrimaryDomainAction(input: unknown): Promise<ActionResult<TenantDomain>> {
  return runAction({
    permission: 'domain:write',
    parser: IdSchema,
    input,
    perform: setPrimaryTenantDomain,
    revalidate: DOMAINS_PATH,
    label: 'Set primary domain',
  });
}

export async function removeDomainAction(input: unknown): Promise<ActionResult<void>> {
  return runAction({
    permission: 'domain:write',
    parser: IdSchema,
    input,
    perform: async (domainId) => {
      await deleteTenantDomain(domainId);
    },
    revalidate: DOMAINS_PATH,
    label: 'Remove domain',
  });
}

const DOMAINS_PATH = routes.settingsDomains();
