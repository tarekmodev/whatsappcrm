import { Suspense } from 'react';
import type { Metadata } from 'next';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requireAnyPermission } from '@/lib/session/session';
import { PageHeader } from '@/components/shell/PageHeader';
import { Stack } from '@/components/layout/Stack';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PeopleFilterBar } from '@/features/people/components/PeopleFilterBar';
import {
  PeopleSections,
  PeopleSectionsSkeleton,
} from '@/features/people/components/PeopleSections';

/**
 * Agents and teams management. Composition only: gate, header, filters, and the
 * section group behind a Suspense boundary with its own skeleton.
 */

export const metadata: Metadata = {
  title: `${content.people.title} · ${content.app.name}`,
  description: content.people.subtitle,
};

/** Filters are per-principal and per-URL, so nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const PEOPLE_MANAGEMENT_PERMISSIONS = ['user:invite', 'user:update', 'team:write'] as const;

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requireAnyPermission(PEOPLE_MANAGEMENT_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const filters = {
    role: parseRole(firstSearchParam(params[searchParamKeys.peopleRole])),
    q: firstSearchParam(params[searchParamKeys.peopleQuery]),
  };

  return (
    <Stack gap="5">
      <PageHeader title={content.people.title} subtitle={content.people.subtitle} />
      <PeopleFilterBar />
      <SectionErrorBoundary>
        {/* Keyed on the filters so a filter change shows the skeleton again rather
            than leaving stale rows on screen while the new page streams in. */}
        <Suspense
          key={`${filters.role ?? ''}:${filters.q ?? ''}`}
          fallback={<PeopleSectionsSkeleton />}
        >
          <PeopleSections
            principal={session.principal}
            checker={session.checker}
            filters={filters}
          />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}

/** An unrecognised `?role=` is dropped, not an error — the URL is untrusted. */
function parseRole(value: string | undefined): TenantRole | undefined {
  return TENANT_ROLES.find((role) => role === value);
}
