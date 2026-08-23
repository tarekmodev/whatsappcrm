import { unstable_rethrow } from 'next/navigation';
import type { AdminTenantLifecycleEvent, CursorPage } from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { listTenantLifecycleEvents } from '@/lib/api/admin';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { TenantLifecycleActions } from './TenantLifecycleActions';
import { TenantStatePanel } from './TenantStatePanel';
import { TenantTrailTable } from './TenantTrailTable';
import { TenantLifecycleSectionSkeleton } from './TenantLifecycleSection.Skeleton';
import { currentStatusOf, latestEventOf, tenantActions } from '../tenant-presentation';

/**
 * Everything the operator console can say about one tenant. Usage:
 * `<TenantLifecycleSection slug={slug} cursor={cursor} />`.
 *
 * A server component: the reads happen once on the server, so the page stays
 * composition only and the trail never ships to the browser as data. The card
 * frames and headings are owned here rather than in the page, which is what lets
 * the skeleton beside this file reuse the identical frames.
 *
 * ## One read on the newest page, two on any other
 *
 * The state panel is derived from the *newest* row of the trail — the admin API
 * has no tenant read, so that is the only place a current status exists. A pager
 * that just re-pointed the one read would make the status panel describe whatever
 * the tenant was doing three months ago, which is exactly the mistake to make
 * before pressing Suspend. So the newest page is always read, and a second read
 * is made only when `?cursor=` names a different one.
 */
export async function TenantLifecycleSection({
  slug,
  cursor,
}: {
  slug: string;
  /** `undefined` for the newest page, which is what the bare route shows. */
  cursor?: string;
}) {
  const copy = content.platformAdmin.tenant;
  const newest = await readTrail(slug);

  if (newest === null) {
    return <TenantNotFound />;
  }

  const trail = cursor === undefined ? newest : ((await readTrail(slug, cursor)) ?? newest);
  const status = currentStatusOf(newest.items);

  return (
    <Stack gap="5">
      <SectionCard id="tenant-state" title={copy.stateHeading} description={copy.stateDescription}>
        <Stack gap="5">
          <TenantStatePanel status={status} latest={latestEventOf(newest.items)} />
          <TenantLifecycleActions slug={slug} availability={tenantActions(status)} />
        </Stack>
      </SectionCard>

      {/*
        A card that exists to say the figures are not here. The reference design
        puts plan, seat usage and MRR on this screen and the admin API exposes
        none of them; an empty panel would read as a section that failed to load,
        and omitting it entirely would leave the next person to re-derive the gap
        from the controller.
      */}
      <SectionCard id="tenant-plan" title={copy.planHeading}>
        <Notice tone="info" variant="quiet">
          {copy.planNotice}
        </Notice>
      </SectionCard>

      <SectionCard id="tenant-trail" title={copy.trailHeading} description={copy.trailDescription}>
        {trail.items.length === 0 ? (
          <EmptyState
            icon="checklist"
            title={copy.trailEmptyTitle}
            description={copy.trailEmptyBody}
          />
        ) : (
          <Stack gap="4">
            <TenantTrailTable events={trail.items} />
            <TrailPager
              slug={slug}
              nextCursor={trail.nextCursor}
              isFirstPage={cursor === undefined}
            />
          </Stack>
        )}
      </SectionCard>
    </Stack>
  );
}

/**
 * The pager, in the URL rather than in state — a page of somebody's audit trail
 * is what an operator sends to a colleague mid-incident.
 *
 * Forward only, because the API publishes a `nextCursor` and nothing else. The
 * way back is the bare route, which is offered from any page but the first —
 * "newest" is a destination an operator can always name, and a browser's back
 * button is not something to make load-bearing.
 */
function TrailPager({
  slug,
  nextCursor,
  isFirstPage,
}: {
  slug: string;
  nextCursor: string | null;
  isFirstPage: boolean;
}) {
  if (nextCursor === null && isFirstPage) {
    return null;
  }

  return (
    <Cluster gap="3">
      {isFirstPage ? null : (
        <ButtonLink href={routes.adminTenant(slug)} variant="secondary">
          {content.platformAdmin.tenant.backToNewest}
        </ButtonLink>
      )}
      {nextCursor === null ? null : (
        <ButtonLink href={routes.adminTenant(slug, { cursor: nextCursor })} variant="secondary">
          {content.platformAdmin.tenant.loadMore}
        </ButtonLink>
      )}
    </Cluster>
  );
}

/**
 * The one refusal this screen renders itself rather than letting the boundary
 * take: a mistyped slug is the ordinary outcome of typing one, and an error state
 * with a retry button would offer to try the same wrong slug again.
 *
 * No `SectionCard` around it. A card with `isTitleVisible={false}` keeps its
 * heading in the accessible tree for the region's name, and the name it would
 * carry is the sentence the state below already says — so a screen reader heard
 * "No tenant with that slug" twice. `StateLayout` is drawn to sit directly on its
 * container's surface anyway; the card was adding a frame it does not want.
 */
function TenantNotFound() {
  return (
    <EmptyState
      icon="search"
      title={content.platformAdmin.tenants.notFoundTitle}
      description={content.platformAdmin.tenants.notFoundBody}
      action={
        <ButtonLink href={routes.adminTenants()} variant="primary">
          {content.platformAdmin.tenants.backToLookup}
        </ButtonLink>
      }
    />
  );
}

/**
 * One page of the trail, or `null` when the slug names no tenant.
 *
 * Only `not_found` is caught. Everything else — the API being down, a malformed
 * response, a credential the guard has stopped accepting — belongs to the
 * boundary above, or in the last case to `lib/api/admin.ts`, which turns it into
 * a redirect rather than an error page.
 */
async function readTrail(
  slug: string,
  cursor?: string,
): Promise<CursorPage<AdminTenantLifecycleEvent> | null> {
  try {
    return await listTenantLifecycleEvents(slug, cursor);
  } catch (error) {
    // First, and before anything else looks at it: a rejected credential is
    // answered with a `redirect`, which Next implements by throwing. Caught here
    // and read as "some other failure", that navigation would be swallowed and
    // the operator would sit on a screen they are no longer authenticated for.
    unstable_rethrow(error);

    if (error instanceof ApiRequestError && error.code === 'not_found') {
      return null;
    }

    throw error;
  }
}

export { TenantLifecycleSectionSkeleton };
