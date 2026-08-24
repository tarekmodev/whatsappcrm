'use client';

import { brandCssVariables, type TenantBranding } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { isPlatformDefault } from '@/lib/branding/brand-style';
import { useContent } from '@/lib/content';
import styles from './BrandingPreview.module.css';

/**
 * What the tenant's colours look like, live, before they are saved. Usage:
 * `<BrandingPreview branding={draft} theme={theme} />`.
 *
 * It renders **through whatever the document renders through**, scoped to this
 * panel by setting the seven custom properties on its own wrapper. That is the
 * whole reason it is honest: the preview is not a hand-painted approximation of
 * the accent, it is the accent — including the automatic `on-accent` correction,
 * so an admin who picks pale yellow sees the dark text the console will actually
 * use rather than an unreadable mock-up that ships.
 *
 * ## Why the default case sets nothing
 *
 * "Whatever the document renders through" stopped being one answer in TAR-801.
 * `brandStyleSheet` emits no block for a tenant still on the platform colours, so
 * the console draws those from the token layer — which declares the accent *per
 * theme*, because one hue cannot be both a button ground and readable link text
 * against a near-black page. Deriving here regardless would have shown a dark-mode
 * link sample at 3.00:1 beside a console rendering that same role at 6.35:1, under
 * a label promising the two agree. Setting no custom properties at all is what
 * makes them agree: the panel inherits the same cascade as everything around it.
 *
 * Setting custom properties inline is the one inline style this codebase allows,
 * and this is exactly the case it is for: the values are per-instance and change
 * as the user types, while every rule that consumes them lives in the module file.
 */

export interface BrandingPreviewProps {
  /** The draft, not the saved record — that is the point of a live preview. */
  branding: TenantBranding;
  /**
   * Which theme to preview. The console shows the one the admin is currently in,
   * so what they see matches the screen around it.
   */
  theme: 'light' | 'dark';
}

export function BrandingPreview({ branding, theme }: BrandingPreviewProps) {
  const content = useContent();

  return (
    <div
      className={styles.preview}
      // `inert` would be the tidier way to keep these out of the tab order, but
      // its support is still uneven; nothing here is focusable to begin with —
      // they are spans styled as controls, not buttons — so there is nothing to
      // remove. Announced as a group with a name instead of being hidden, so a
      // screen-reader user can tell the section is a sample.
      role="group"
      aria-label={content.branding.previewHeading}
      /*
       * Undefined, not an empty object: React omits the attribute entirely, so
       * there is nothing on this element for the platform layer to lose to.
       */
      style={
        isPlatformDefault(branding)
          ? undefined
          : (brandCssVariables(branding, theme) as React.CSSProperties)
      }
    >
      <Stack gap="4">
        <div className={styles.actions}>
          <span className={styles.primaryAction}>{content.branding.previewButton}</span>
          <span className={styles.secondaryAction}>{content.branding.previewSecondaryButton}</span>
          <span className={styles.badge}>{content.branding.previewBadge}</span>
        </div>
        <p className={styles.body}>
          {content.branding.previewBodyText}{' '}
          <span className={styles.link}>{content.branding.previewLinkText}</span>
        </p>
        {/* The decorative colour, shown as the band it actually is — never with
            text on it, which is the rule that keeps it out of contrast checks. */}
        <span className={styles.decor} aria-hidden="true" />
      </Stack>
    </div>
  );
}
