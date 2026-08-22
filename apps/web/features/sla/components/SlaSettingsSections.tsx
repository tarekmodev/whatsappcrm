import type { Permission } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { EmptyState } from '@/components/ui/EmptyState';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadSlaPolicies } from '../sla-policies.data';
import { SlaOverridesSection } from './SlaOverridesSection';
import { SlaWindowDetails } from './SlaWindowDetails';
import { SlaWindowFormSkeleton } from './SlaWindowForm.Skeleton';
import { LazySlaWindowForm } from './sla-settings.lazy';

/**
 * Fetches the tenant's SLA policies and composes the page's sections. Usage:
 * inside a Suspense boundary on the response-deadlines settings page, with
 * `SlaSettingsSectionsSkeleton` as the fallback.
 *
 * A server component, so the permission decision and the read both happen on the
 * server and the client bundle carries neither.
 *
 * **The future-tickets notice is above the form, not inside it.** It is true
 * whether or not the reader may edit — an agent-turned-supervisor reading the
 * read-only variant still needs to know a change would not move a running
 * deadline — and putting it in the form would leave it unsaid for exactly the
 * reader with the least context.
 *
 * `canWrite` comes from the server's check and only decides which variant
 * renders: the server action asserts `sla:write` again and the API a third time.
 */

/** The permissions this surface's controls are gated on, named once. */
export const SLA_SETTINGS_PERMISSIONS = {
  read: 'sla:read',
  write: 'sla:write',
} as const satisfies Record<string, Permission>;

export async function SlaSettingsSections({ checker }: { checker: PermissionChecker }) {
  const { defaultPolicy, overrides, hasMore } = await loadSlaPolicies();
  const canWrite = checker.can(SLA_SETTINGS_PERMISSIONS.write);
  const copy = content.slaSettings;

  return (
    <Stack gap="5">
      <SectionCard id="sla-window" title={copy.windowHeading} description={copy.windowDescription}>
        {defaultPolicy === null ? (
          // A tenant with no catch-all policy is a real state rather than a
          // fault: provisioning seeds one and the service adds one lazily, but
          // both are guarded on "no policy at all", so a workspace whose only
          // rows are per-priority ones legitimately has none. Saying so beats
          // rendering a form with nothing to PATCH.
          <EmptyState
            icon="clock"
            title={copy.noPolicyHeading}
            description={copy.noPolicyBody}
            tone="quiet"
          />
        ) : (
          <Stack gap="4">
            <Notice tone="info" variant="quiet">
              {copy.futureTicketsNotice}
            </Notice>
            {canWrite ? (
              <LazyBoundary fallback={<SlaWindowFormSkeleton />}>
                <LazySlaWindowForm policy={defaultPolicy} />
              </LazyBoundary>
            ) : (
              <Stack gap="4">
                <Notice tone="info">{copy.readOnlyNotice}</Notice>
                <SlaWindowDetails policy={defaultPolicy} />
              </Stack>
            )}
          </Stack>
        )}
      </SectionCard>

      {overrides.length === 0 ? null : (
        <SlaOverridesSection overrides={overrides} hasMore={hasMore} />
      )}
    </Stack>
  );
}

/**
 * The fallback. The same stack, the same card, the same notice and the form's
 * own skeleton in the same `Stack`, so the card is exactly as tall before the
 * data lands as after — measured at 1440px, and the notice is in here because
 * leaving it out cost 56px of shift on the common path.
 *
 * **The notice is real copy, not a placeholder**, and it is drawn
 * unconditionally although the sections omit it for a workspace with no
 * catch-all policy. That state is rare — provisioning seeds one — so drawing it
 * is right on every path but one, where a notice is replaced by an empty state
 * rather than by nothing.
 *
 * The overrides card is **not** drawn: whether it appears depends on data that
 * has not arrived, and most workspaces have no overrides at all, so reserving
 * space for it would leave a gap on the common path. It appears *below* the card
 * the reader came for, so it pushes nothing they are looking at.
 *
 * The form's skeleton rather than the read-only variant's, for the reason
 * `WorkspaceSectionsSkeleton` always draws its plan card: this route's
 * `loading.tsx` has no session to read, and every principal who reaches this
 * page under today's role table holds `sla:write`.
 *
 * Changed in the same commit as the sections it stands in for.
 */
export function SlaSettingsSectionsSkeleton() {
  const copy = content.slaSettings;

  return (
    <Stack gap="5">
      <SectionCard id="sla-window" title={copy.windowHeading} description={copy.windowDescription}>
        <Stack gap="4">
          <Notice tone="info" variant="quiet">
            {copy.futureTicketsNotice}
          </Notice>
          <SlaWindowFormSkeleton />
        </Stack>
      </SectionCard>
    </Stack>
  );
}
