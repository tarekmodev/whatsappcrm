import {
  BRANDING_DEFAULTS,
  brandCssVariables,
  type BrandTheme,
  type TenantBranding,
} from '@whatsappcrm/contracts';

/**
 * The tenant's accent tokens as a stylesheet, for the root layout to emit.
 *
 * Two selectors, one per theme, re-declaring the *same seven role names* — which
 * is the whole trick: no component reads `branding`, no component branches on the
 * theme, and swapping the identity is swapping this block. It sits after
 * `semantic.css` in the cascade with equal specificity, so it overrides the
 * platform defaults for those seven names and touches nothing else.
 *
 * Server-rendered into the first HTML response, so there is no unbranded flash
 * and no client-side correction to hydrate around.
 */

/**
 * The theme selectors, deliberately **one step more specific** than the ones in
 * `styles/tokens/semantic.css` (`:root, [data-theme='light']` and
 * `[data-theme='dark']`, both 0-1-0).
 *
 * Source order would otherwise decide this, and source order is not ours to
 * choose: Next emits the imported stylesheets as `<link>`s and React hoists this
 * block into `<head>` separately, so a build that reorders the two would silently
 * hand every token back to the platform default. At 0-2-0 the tenant's values win
 * wherever the block lands.
 *
 * `:not([data-theme='dark'])` rather than a bare `:root`, so the dark rule below
 * — same specificity, later in the block — is the one that applies in dark mode
 * rather than fighting a `:root:root` that matches both.
 */
const THEME_SELECTORS: Record<BrandTheme, string> = {
  light: ":root:not([data-theme='dark'])",
  dark: ":root[data-theme='dark']",
};

/**
 * A tenant that has chosen neither colour gets **no block at all**, and that is
 * the difference between "the platform's accent" and "a hex that happens to equal
 * it" (TAR-801).
 *
 * `brandCssVariables` derives one accent from one hue and emits it into both
 * themes, because that is the contract a tenant's colour has: it is passed
 * through untouched. The platform layer is not bound by that, and since the Reqta
 * port it is not *expressible* under it either — an accent is a ground under a
 * button label in one direction and link text in the other, and against a
 * near-black page a single hex cannot clear AA in both (`semantic.css`). The
 * token layer answers that by inverting the pair per theme.
 *
 * Emitting the defaults would overwrite that answer with the light theme's hue in
 * both themes, and every unbranded console — which is most of them — would render
 * dark-mode links at 2.79:1. So when there is nothing to say, this says nothing
 * and `semantic.css` stands.
 *
 * A tenant who *has* picked a colour still gets it exactly as before. The dark
 * theme's accent-as-link is under-contrast for them too, at whatever their hue
 * measures; that is the pre-existing shape of the tenant contract rather than
 * something this function may quietly change, and it needs either an eighth
 * tenant-owned token or a per-theme step of the tenant's hue — see 0001's
 * "What TAR-801 left open".
 */
export function isPlatformDefault(branding: TenantBranding): boolean {
  return (
    branding.primaryColor === BRANDING_DEFAULTS.primaryColor &&
    branding.accentColor === BRANDING_DEFAULTS.accentColor
  );
}

export function brandStyleSheet(branding: TenantBranding): string {
  if (isPlatformDefault(branding)) {
    return '';
  }

  return (Object.keys(THEME_SELECTORS) as BrandTheme[])
    .map((theme) => {
      const declarations = Object.entries(brandCssVariables(branding, theme))
        .map(([name, value]) => `${name}:${value}`)
        .join(';');

      return `${THEME_SELECTORS[theme]}{${declarations}}`;
    })
    .join('\n');
}
