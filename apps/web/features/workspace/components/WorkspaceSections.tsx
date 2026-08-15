import type { Permission } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadWorkspace } from '../workspace.data';
import { BrandingSummary } from './BrandingSummary';
import { BrandingSummarySkeleton } from './BrandingSummary.Skeleton';
import { LifecycleBanner } from './LifecycleBanner';
import { PlanStatusPanel } from './PlanStatusPanel';
import { PlanStatusPanelSkeleton } from './PlanStatusPanel.Skeleton';
import { WorkspaceProfileDetails } from './WorkspaceProfileDetails';
import { WorkspaceProfileFormSkeleton } from './WorkspaceProfileForm.Skeleton';
import { LazyWorkspaceProfileForm } from './workspace-widgets.lazy';

/**
 * Fetches the workspace data and composes the page's three sections. Usage:
 * inside a Suspense boundary on the workspace settings page, with
 * `WorkspaceSectionsSkeleton` as the fallback.
 *
 * A server component, so both permission decisions and both reads happen on the
 * server and the client bundle carries neither.
 *
 * The page is deliberately two surfaces behind two gates. The profile writes
 * `PATCH /tenant` (`branding:write`); the plan panel reads
 * `GET /tenant/lifecycle` (`tenant:settings`). Both are admin-only under today's
 * role table, so nobody currently sees half of this — the split exists so a
 * custom role holding one of them gets the half it may have instead of a 403 for
 * the whole page.
 */

/** The permissions this surface's controls are gated on, named once. */
export const WORKSPACE_PERMISSIONS = {
  editProfile: 'branding:write',
  readPlan: 'tenant:settings',
} as const satisfies Record<string, Permission>;

export async function WorkspaceSections({ checker }: { checker: PermissionChecker }) {
  const canEditProfile = checker.can(WORKSPACE_PERMISSIONS.editProfile);
  const { tenant, lifecycle } = await loadWorkspace({
    canReadLifecycle: checker.can(WORKSPACE_PERMISSIONS.readPlan),
  });

  return (
    <Stack gap="5">
      {lifecycle === null ? null : <LifecycleBanner lifecycle={lifecycle} />}

      <SectionCard
        id="workspace-profile"
        title={content.workspace.profileHeading}
        description={content.workspace.profileDescription}
      >
        {canEditProfile ? (
          <LazyBoundary fallback={<WorkspaceProfileFormSkeleton />}>
            <LazyWorkspaceProfileForm tenant={tenant} />
          </LazyBoundary>
        ) : (
          <Stack gap="4">
            <Notice tone="info">{content.workspace.profileReadOnlyNotice}</Notice>
            <WorkspaceProfileDetails tenant={tenant} />
          </Stack>
        )}
      </SectionCard>

      <SectionCard
        id="workspace-branding"
        title={content.workspace.brandingHeading}
        description={content.workspace.brandingDescription}
      >
        <BrandingSummary branding={tenant.branding} />
      </SectionCard>

      {lifecycle === null ? null : (
        <SectionCard
          id="workspace-plan"
          title={content.workspace.planHeading}
          description={content.workspace.planDescription}
        >
          <PlanStatusPanel lifecycle={lifecycle} />
        </SectionCard>
      )}
    </Stack>
  );
}

/**
 * The fallback. The same stack and gap and the same three cards, each holding
 * its own section's skeleton, so the page does not reflow when the data lands.
 *
 * No banner placeholder, deliberately: whether a banner appears at all depends
 * on data that has not arrived, and reserving space for one would leave a gap on
 * the common path where there is nothing to warn about. A banner that pushes the
 * cards down when it appears is correct — it is the page telling somebody
 * something they need to read.
 *
 * The plan card is always drawn here, even though the real sections omit it for
 * a principal without `tenant:settings`. Under today's role table nobody reaches
 * this page without it, and the alternative would be threading the permission
 * into the route's `loading.tsx`, which has no session to read.
 *
 * Changed in the same commit as the sections it stands in for.
 */
export function WorkspaceSectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        id="workspace-profile"
        title={content.workspace.profileHeading}
        description={content.workspace.profileDescription}
      >
        <WorkspaceProfileFormSkeleton />
      </SectionCard>
      <SectionCard
        id="workspace-branding"
        title={content.workspace.brandingHeading}
        description={content.workspace.brandingDescription}
      >
        <BrandingSummarySkeleton />
      </SectionCard>
      <SectionCard
        id="workspace-plan"
        title={content.workspace.planHeading}
        description={content.workspace.planDescription}
      >
        <PlanStatusPanelSkeleton />
      </SectionCard>
    </Stack>
  );
}
