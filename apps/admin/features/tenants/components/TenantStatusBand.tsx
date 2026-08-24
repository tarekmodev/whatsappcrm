import type { TenantStatus } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { content } from '~/content/en';
import { tenantStatusTone } from '../tenant-presentation';

/**
 * The tenant's status, at page level, directly under the `<h1>` (spec §2.4).
 *
 * It was a `<dt>`/`<dd>` row two cards down, and that is the wrong place for it:
 * this screen's job is to answer "what state is this tenant in" *before* somebody
 * opens the Manage menu, and a definition list below the fold is not an answer at
 * a glance.
 *
 * §2.4 budgets the band at **two** chips — this one, and one time-bounded chip
 * (`Trial ends`, `Grace period ends`, `Purges`). The second is absent because
 * every date it could name lives on `AdminTenantLifecycleResponse`, a *write*
 * response, so a freshly loaded screen has none of them. It joins this band when
 * a tenant read lands; see `tenant-presentation.ts`.
 *
 * A tenant whose trail is empty has no readable status. It says so rather than
 * rendering nothing — an operator about to press Suspend needs the difference
 * between "active" and "we could not tell" to be visible.
 */
export function TenantStatusBand({ status }: { status: TenantStatus | null }) {
  return (
    /*
     * The `<section>` is written here rather than passed to `Cluster` as `as`:
     * `Cluster` takes a fixed prop list and does not spread the rest, so an
     * `aria-label` handed to it is silently dropped — and a named region is the
     * whole reason this is a landmark rather than two loose chips. A screen
     * reader should hear what the row is before the value in it.
     */
    <section aria-label={content.tenant.bandLabel}>
      <Cluster gap="2">
        {status === null ? (
          <Badge tone="neutral" size="md">
            {content.tenant.statusUnknown}
          </Badge>
        ) : (
          <Badge tone={tenantStatusTone(status)} size="md">
            {content.tenantStatuses[status]}
          </Badge>
        )}
      </Cluster>
    </section>
  );
}
