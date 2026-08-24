import type { AdminTenantLifecycleEvent, CursorPage } from '@whatsappcrm/contracts';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SectionCard } from '@/components/ui/SectionCard';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { attemptRead } from '~/lib/attempt-read';
import { listTenantTrail } from '~/lib/api/admin';
import { CredentialRefused } from '~/features/shell/components/CredentialRefused';
import { currentStatusOf, latestEventOf, tenantWrites } from '../tenant-presentation';
import { ManageTenantMenu } from './ManageTenantMenu';
import { TenantStatusBand } from './TenantStatusBand';
import { TenantTrailTable } from './TenantTrailTable';

/**
 * One tenant, as the platform sees it (spec §2.4). A server component: the reads
 * happen once on the server, so the page stays composition only and the trail
 * never ships to the browser as data.
 *
 * ## Two drifts from the spec, both forced by the API
 *
 * 1. **The `<h1>` is the slug, not the tenant's name**, drawn as the identifier
 *    it is. §2.4 asks for the name with the slug beneath it; no read on the admin
 *    surface returns a name — `AdminTenantLifecycleEvent` carries none, and only
 *    the writes do. A heading assembled from a name this console was never given
 *    would be the one invented thing on the screen, so the slot beneath it stays
 *    empty until there is a name to put in it.
 * 2. **The status band carries one chip, not two.** §2.4 allows a time-bounded
 *    chip beside the status; every date it could name is on a *write* response,
 *    so a freshly loaded screen has none.
 *
 * Both close the moment a `GET /admin/tenants/{slug}` lands, which is the same
 * endpoint the tenant list needs.
 *
 * ## One read on the newest page, two on any other
 *
 * The status is derived from the *newest* row of the trail — the only place a
 * current status exists. A pager that just re-pointed the one read would make the
 * status describe whatever the tenant was doing three months ago, which is
 * exactly the mistake to make before pressing Suspend. So the newest page is
 * always read, and a second read happens only when `?cursor=` names another.
 */
export async function TenantSection({ slug, cursor }: { slug: string; cursor?: string }) {
  const newest = await attemptRead(async () => await listTenantTrail(slug));

  if (newest.status === 'credential-refused') {
    return <CredentialRefused />;
  }

  if (newest.status === 'not-found') {
    return <TenantNotFound slug={slug} />;
  }

  const trail = cursor === undefined ? newest.data : await readPage(slug, cursor, newest.data);
  const status = currentStatusOf(newest.data.items);
  const latest = latestEventOf(newest.data.items);
  const writes = tenantWrites(status);

  /*
   * The status has left this list for the band under the heading (§2.4). What is
   * left is the one thing the trail *does* tell us beyond the state itself: when
   * it last moved, and who moved it.
   */
  const stateItems: DetailListItem[] =
    latest === null
      ? []
      : [
          {
            id: 'last-changed',
            term: content.tenant.lastChangedLabel,
            value: (
              <RelativeTime
                isoTimestamp={latest.occurredAt}
                label={content.tenant.occurredAtLabel}
              />
            ),
            // The credential label, or the admin's email at the time. Naming it
            // beside the instant answers "who did this" without dropping into the
            // table below.
            hint: latest.actorLabel ?? content.lifecycleActors[latest.actorType],
          },
        ];

  return (
    <Stack gap="5">
      {/*
        A purged tenant renders in full, and says so above everything else.
        Omitting its writes is right — the graph has no edge out of `deleted` —
        but omitting them *silently* leaves a screen whose menu has simply
        vanished, which is the absence-instead-of-a-statement this console avoids
        everywhere else.

        The date is dropped rather than invented: `deletedAt` is on a write
        response this console may never have made.
      */}
      {status === 'deleted' ? (
        <AlertBanner tone="danger" heading={content.tenant.purgedBannerHeading}>
          {content.tenant.purgedBannerBody(null)}
        </AlertBanner>
      ) : null}

      <PageHeader
        title={slug}
        titleVariant="identifier"
        action={<ManageTenantMenu slug={slug} name={slug} writes={writes} />}
      />
      <TenantStatusBand status={status} />

      <SectionCard id="lifecycle" title={content.tenant.lifecycleHeading}>
        <Stack gap="4">
          {stateItems.length === 0 ? null : <DetailList items={stateItems} />}
          {/*
            Said rather than left as an empty card: the dates the spec asks for
            here are only ever returned by a write, so a console that has not made
            one this session genuinely does not have them.
          */}
          <Notice tone="info" variant="quiet">
            {status === null ? content.tenant.statusUnknownHint : content.tenant.lifecycleUnknown}
          </Notice>
        </Stack>
      </SectionCard>

      <SectionCard
        id="history"
        title={content.tenant.historyHeading}
        description={content.tenant.historyCount(trail.items.length, trail.nextCursor !== null)}
      >
        {trail.items.length === 0 ? (
          <EmptyState
            icon="checklist"
            title={content.tenant.historyEmptyTitle}
            description={content.tenant.historyEmptyBody}
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
 * A page of the trail other than the newest, falling back to the newest when the
 * cursor names nothing.
 *
 * A stale cursor in a shared link is not an error worth a boundary — the trail is
 * still there, and the newest page is what the bare route would have shown.
 */
async function readPage(
  slug: string,
  cursor: string,
  fallback: CursorPage<AdminTenantLifecycleEvent>,
): Promise<CursorPage<AdminTenantLifecycleEvent>> {
  const page = await attemptRead(async () => await listTenantTrail(slug, cursor));

  return page.status === 'ok' ? page.data : fallback;
}

/**
 * Forward only, because the API publishes a `nextCursor` and nothing else. The
 * way back is the bare route, offered from any page but the first — "newest" is a
 * destination an operator can always name, and the back button is not something
 * to make load-bearing.
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
        <ButtonLink href={routes.tenant(slug)} variant="secondary">
          {content.tenant.backToNewest}
        </ButtonLink>
      )}
      {nextCursor === null ? null : (
        <ButtonLink href={routes.tenant(slug, { cursor: nextCursor })} variant="secondary">
          {content.tenant.loadOlder}
        </ButtonLink>
      )}
    </Cluster>
  );
}

/**
 * A mistyped slug is the ordinary outcome of typing one, so this is an
 * `EmptyState` rather than an `ErrorState`: nothing failed, and a retry button
 * would offer to try the same wrong slug again. The slug is quoted back, because
 * a message that does not echo the input does not help anybody find their typo.
 */
function TenantNotFound({ slug }: { slug: string }) {
  return (
    <EmptyState
      icon="search"
      title={content.tenants.notFoundTitle(slug)}
      description={content.tenants.notFoundBody}
      action={
        <ButtonLink href={routes.tenants()} variant="primary">
          {content.tenants.backToTenants}
        </ButtonLink>
      }
    />
  );
}
