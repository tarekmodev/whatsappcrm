import { brandCssVariables, type BrandTheme, type TenantBranding } from '@whatsappcrm/contracts';

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

export function brandStyleSheet(branding: TenantBranding): string {
  return (Object.keys(THEME_SELECTORS) as BrandTheme[])
    .map((theme) => {
      const declarations = Object.entries(brandCssVariables(branding, theme))
        .map(([name, value]) => `${name}:${value}`)
        .join(';');

      return `${THEME_SELECTORS[theme]}{${declarations}}`;
    })
    .join('\n');
}
