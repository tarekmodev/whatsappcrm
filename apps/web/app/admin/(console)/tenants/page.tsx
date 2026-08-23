import type { Metadata } from 'next';
import { content } from '@/content/en';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { TenantLookupForm } from '@/features/platform-admin/components/TenantLookupForm';

/**
 * The operator console's entry point. Composition only: a header and one card.
 *
 * It reads nothing. There is no `GET /admin/tenants` to read *from* — see
 * `lib/api/admin.ts` for the whole admin surface — so this screen is the lookup
 * and the sentence that says why it is a lookup, and the tenant read happens on
 * the route it navigates to.
 *
 * The credential gate is the layout's and, authoritatively, each admin call's.
 * Nothing here calls the API, so there is nothing on this screen to gate twice.
 */

export const metadata: Metadata = {
  title: content.platformAdmin.tenants.title,
  description: content.platformAdmin.tenants.subtitle,
};

export default function PlatformAdminTenantsPage() {
  return (
    <PageShell>
      <PageHeader
        title={content.platformAdmin.tenants.title}
        subtitle={content.platformAdmin.tenants.subtitle}
      />
      <SectionCard
        id="tenant-lookup"
        title={content.platformAdmin.tenants.lookupHeading}
        description={content.platformAdmin.tenants.lookupDescription}
      >
        <Stack gap="4">
          <TenantLookupForm />
          {/*
            Guidance, not a failure: `quiet` keeps the tone's text colour and
            drops the banner, so a permanent sentence about the API's shape does
            not out-shout the form it is explaining.
          */}
          <Notice tone="info" variant="quiet">
            {content.platformAdmin.tenants.noListNotice}
          </Notice>
        </Stack>
      </SectionCard>
    </PageShell>
  );
}
