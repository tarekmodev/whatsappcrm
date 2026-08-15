import type { TenantBranding } from '@whatsappcrm/contracts';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import styles from './BrandingSummary.module.css';

/**
 * The branding entry point TAR-409 asks for, and the honest version of it.
 *
 * TAR-29 owns the editor — logo, favicon and colours — and it has not landed, so
 * there is no endpoint to write these to and no route to link to. What this does
 * instead is show what is currently in effect and say plainly where the editor
 * will be. A colour picker wired to nothing, or a link to a page that 404s,
 * would both be worse than an admission.
 *
 * When TAR-29 lands, this becomes the section's read view beside its edit
 * control: the shape it renders is already `TenantBranding`, so nothing here has
 * to change to make room for it.
 */
export function BrandingSummary({ branding }: { branding: TenantBranding }) {
  const content = useContent();

  return (
    <Stack gap="4">
      <DetailList items={brandingDetails(branding, content)} />
      <Notice tone="info">{content.workspace.brandingPendingNotice}</Notice>
    </Stack>
  );
}

function brandingDetails(branding: TenantBranding, content: Content): readonly DetailListItem[] {
  return [
    {
      id: 'product-name',
      term: content.workspace.brandingProductName,
      value: branding.productName,
    },
    {
      id: 'primary-colour',
      term: content.workspace.brandingPrimaryColour,
      value: <ColourValue hex={branding.primaryColor} />,
    },
    {
      id: 'accent-colour',
      term: content.workspace.brandingAccentColour,
      value: <ColourValue hex={branding.accentColor} />,
    },
    {
      id: 'logo',
      term: content.workspace.brandingLogo,
      // `next/image` needs intrinsic dimensions the contract does not carry, and
      // a logo of unknown aspect ratio in a reserved box is TAR-29's problem to
      // solve properly. The URL is the honest thing to show until then.
      value: branding.logoUrl ?? content.workspace.brandingLogoEmpty,
    },
  ];
}

/**
 * The hex code beside a swatch, never the swatch alone: the code *is* the value,
 * and a square of colour conveys nothing to a screen reader, in forced-colors
 * mode, or to anyone who cannot tell two greens apart. The swatch is therefore
 * `aria-hidden` decoration and needs no label of its own — the code next to it
 * already says everything it does.
 *
 * The colour is a per-instance data value, so it arrives as a custom property
 * and the rule that paints it lives in the module.
 */
function ColourValue({ hex }: { hex: string }) {
  return (
    <span className={styles.colour}>
      <span
        aria-hidden="true"
        className={styles.swatch}
        style={{ '--swatch-colour': hex } as React.CSSProperties}
      />
      <span className={styles.hex}>{hex}</span>
    </span>
  );
}
