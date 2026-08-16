import { Stack } from '@/components/layout/Stack';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { getTenant } from '@/lib/api/tenant';
import { readTheme } from '@/lib/theme/read-theme';
import { BrandingAssetCard } from './BrandingAssetCard';
import { BrandingForm } from './BrandingForm';
import { BrandingSectionsSkeleton } from './BrandingSections.Skeleton';
import styles from './BrandingSections.module.css';

/**
 * The branding screen's sections: identity and colours, then the two assets.
 *
 * A server component, so the tenant read happens once on the server and the
 * settings page stays composition only. The frames and headings are owned here
 * rather than in the page, which is what lets the skeleton beside this file reuse
 * the identical frame and hand over without a reflow.
 *
 * ## Why the saved record, not the public one
 *
 * The shell renders `GET /tenant/public`; this reads `GET /tenant`, which is the
 * authenticated view of the same record. They agree, but the editor must read the
 * resource it is about to write rather than the anonymous projection of it — the
 * public endpoint is a *view for the login screen*, and building the admin form
 * on it would tie the editor's fields to whatever an anonymous caller may see.
 */
export async function BrandingSections() {
  const [tenant, theme] = await Promise.all([getTenant(), readTheme()]);

  return (
    <Stack gap="5">
      <SectionCard
        id="branding-identity"
        title={content.branding.coloursHeading}
        description={content.branding.coloursDescription}
      >
        <BrandingForm branding={tenant.branding} theme={theme} />
      </SectionCard>

      <SectionCard
        id="branding-assets"
        title={content.branding.assetsHeading}
        description={content.branding.assetsDescription}
      >
        <div className={styles.assets}>
          <BrandingAssetCard
            kind="logo"
            label={content.branding.logoLabel}
            hint={content.branding.logoHint}
            asset={tenant.branding.logo}
            // Previewed on the rail's own background: a logo drawn for a dark
            // sidebar is usually white, and on a white card it looks like a
            // failed upload.
            previewTone="rail"
          />
          <BrandingAssetCard
            kind="favicon"
            label={content.branding.faviconLabel}
            hint={content.branding.faviconHint}
            asset={tenant.branding.favicon}
          />
        </div>
      </SectionCard>
    </Stack>
  );
}

export { BrandingSectionsSkeleton };
