import type { AdminTenantLifecycleEvent, CursorPage } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
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
import {
  currentStatusOf,
  latestEventOf,
  tenantStatusTone,
  tenantWrites,
} from '../tenant-presentation';
import { ManageTenantMenu } from './ManageTenantMenu';
import { TenantTrailTable } from './TenantTrailTable';

/**
 * One tenant, as the platform sees it (spec §2.4). A server component: the reads
 * happen once on the server, so the page stays composition only and the trail
 * never ships to the browser as data.
 *
 * ## Two drifts from the spec, both forced by the API
 *
 * 1. **The `<h1>` is the slug, not the tenant's name.** §2.4 asks for the name
 *    with the slug beneath it. No read on the admin surface returns a name —
 *    `AdminTenantLifecycleEvent` carries none, and the only responses that do are
 *    the writes. A heading assembled from a name this console was never given
 *    would be the one invented thing on the screen.
 * 2. **There is no Lifecycle date list on first load.** §2.4 asks for a
 *    `DetailList` of every non-null date from `AdminTenantLifecycleResponse` —
 *    which is a *write* response. The trail carries no dates at all, so the card
 *    says what it does know and names why the rest is absent rather than
 *    rendering six empty rows.
 *
 * Both are flagged for the designer check-in. Both close the moment a
 * `GET /admin/tenants/{slug}` lands, which is the same endpoint the tenant list
 * needs.
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

  const stateItems: DetailListItem[] = [
    {
      id: 'status',
      term: content.tenant.columns.change,
      value:
        status === null ? (
          content.tenant.statusUnknown
        ) : (
          <Badge tone={tenantStatusTone(status)} size="md">
            {content.tenantStatuses[status]}
          </Badge>
        ),
      ...(status === null ? { hint: content.tenant.statusUnknownHint } : {}),
    },
    ...(latest === null
      ? []
      : [
          {
            id: 'last-changed',
            term: content.tenant.columns.when,
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
        ]),
  ];

  return (
    <Stack gap="5">
      <PageHeader
        title={slug}
        subtitle={content.tenant.subtitle}
        action={<ManageTenantMenu slug={slug} name={slug} writes={writes} />}
      />

      <SectionCard id="lifecycle" title={content.tenant.lifecycleHeading}>
        <Stack gap="4">
          <DetailList items={stateItems} />
          {/*
            Said rather than left as an empty card: the dates the spec asks for
            here are only ever returned by a write, so a console that has not made
            one this session genuinely does not have them.
          */}
          <Notice tone="info" variant="quiet">
            {content.tenant.lifecycleUnknown}
          </Notice>
          <Notice tone="info" variant="quiet">
            {content.tenant.impersonateNotice}
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
