import type { TenantResponse } from '@whatsappcrm/contracts';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { useContent, type Content } from '@/lib/content';

/**
 * The workspace profile for a principal who may not change it. Usage:
 * `<WorkspaceProfileDetails tenant={tenant} />`.
 *
 * The same three facts `WorkspaceProfileForm` shows, as text. A form of
 * disabled inputs was the alternative and is worse: `disabled` reads as "not
 * right now" rather than "never for you", and a disabled control is skipped by
 * keyboard navigation, so its value becomes unreadable to anyone tabbing
 * through. `StaticFieldValue` documents the same rule for a single field.
 */
export function WorkspaceProfileDetails({ tenant }: { tenant: TenantResponse }) {
  const content = useContent();

  return <DetailList items={details(tenant, content)} />;
}

function details(tenant: TenantResponse, content: Content): readonly DetailListItem[] {
  return [
    { id: 'name', term: content.workspace.nameLabel, value: tenant.name },
    {
      id: 'support-email',
      term: content.workspace.supportEmailLabel,
      value: tenant.branding.supportEmail ?? content.workspace.supportEmailEmpty,
    },
    {
      id: 'address',
      term: content.workspace.addressLabel,
      value: workspaceHostname(tenant) ?? content.workspace.addressEmpty,
      hint: content.workspace.addressHint,
    },
  ];
}

/**
 * The hostname a customer actually types, not the slug it was derived from.
 *
 * `isPrimary` rather than the platform subdomain: a workspace on a verified
 * custom domain reaches itself at that name, and showing the subdomain instead
 * would show an address its own admin never uses. Falls back to the first
 * domain, because a workspace with domains but no primary is a provisioning bug
 * and its address is still more useful than nothing.
 *
 * Exported because the form shows the identical value in its read-only field,
 * and two readings of "which hostname is this workspace" is one too many.
 */
export function workspaceHostname(tenant: TenantResponse): string | undefined {
  const primary = tenant.domains.find((domain) => domain.isPrimary) ?? tenant.domains[0];

  return primary?.hostname;
}
