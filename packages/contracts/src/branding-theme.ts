import { BRANDING_DEFAULTS, type TenantBranding } from './tenant';

/**
 * Turning a tenant's two hex colours into the accent tokens the console renders.
 *
 * It lives in the contract package rather than in `apps/web` because three
 * parties have to agree on the answer: the web tier emits these values into the
 * document, the API may render the same branding into a transactional email, and
 * the accessibility tests assert the pairs. A second implementation is a second
 * set of contrast guarantees.
 *
 * ## The token boundary (ADR: branding & custom-domain contract)
 *
 * Seven names are tenant-owned. Every surface, text, border and status token is
 * platform-owned and is **not** overridable — a tenant cannot make an error state
 * green, and `docs/design/0001`'s measured contrast pairs survive white-labelling.
 *
 * `primaryColor` drives the action accent. `accentColor` drives
 * `--color-brand-decor` and nothing else: decoration, never behind text. That
 * keeps 0001's "one accent carries action" rule while honouring the second
 * column the schema and the seed already carry.
 *
 * ## Why every value is emitted as concrete hex
 *
 * No `color-mix`, no `hsl()` arithmetic in CSS. A derived value that the browser
 * computes is a value no test can assert, and the whole point of this module is
 * that **every pair it produces clears WCAG AA whatever the tenant picks** —
 * which is a property, and properties need a function you can sweep.
 */

/** The seven names a tenant owns. Everything else is the platform's. */
export const BRAND_TOKEN_NAMES = [
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-subtle',
  '--color-on-accent',
  '--color-on-accent-subtle',
  '--color-focus-ring',
  '--color-brand-decor',
] as const;

export type BrandTokenName = (typeof BRAND_TOKEN_NAMES)[number];

export const BRAND_THEMES = ['light', 'dark'] as const;
export type BrandTheme = (typeof BRAND_THEMES)[number];

/**
 * WCAG 2.2 thresholds. 1.4.3 for text, 1.4.11 for a focus indicator against the
 * surface it is drawn on.
 */
const AA_TEXT_CONTRAST = 4.5;
const FOCUS_INDICATOR_CONTRAST = 3;

/**
 * What each theme's platform layer puts behind the tenant's colours, taken from
 * `styles/tokens/semantic.css`. They are duplicated here as literals rather than
 * read from CSS because this module runs in Node, and `brandCssVariables.test.ts`
 * pins them against that file.
 */
interface ThemeGround {
  /** `--color-canvas`; what a focus ring is measured against. */
  readonly canvas: string;
  /** `--color-surface`; what `--color-accent-subtle` is mixed toward. */
  readonly surface: string;
  /** `--color-focus-ring` as the platform ships it, if no derived step clears. */
  readonly fallbackFocusRing: string;
}

const THEME_GROUND: Record<BrandTheme, ThemeGround> = {
  light: { canvas: '#f6f7f9', surface: '#ffffff', fallbackFocusRing: '#4f46e5' },
  dark: { canvas: '#0e1117', surface: '#151923', fallbackFocusRing: '#a5b4fc' },
};

/**
 * The three candidates for text drawn *on* the accent.
 *
 * Two would nearly do: for any colour, contrast-to-white × contrast-to-black is
 * exactly 21, so `max(…) >= sqrt(21) ~ 4.58` and a compliant choice always
 * exists against **pure** black. `#0e1117` — the console's own darkest ground —
 * only reaches ~18.90, so `sqrt(18.90) ~ 4.35`: there is a narrow band of accent
 * luminances where both `#ffffff` and `#0e1117` land just under 4.5:1. TAR-801's
 * palette port widened that band rather than closing it (the old `#020617`
 * reached 20.17), which is why the third candidate is not optional.
 * `#000000` is the third candidate that closes it, and
 * `brandCssVariables.test.ts` sweeps the hex space rather than trusting that
 * arithmetic.
 */
const ON_ACCENT_CANDIDATES = ['#ffffff', '#0e1117', '#000000'] as const;

/**
 * How far `--color-accent-hover` moves from the accent: darker in light, lighter
 * in dark, so hover always reads as "more" of the same colour rather than as a
 * different one.
 */
const HOVER_SHIFT = 0.16;

/**
 * How far `--color-accent-subtle` is mixed toward the theme's surface. High
 * enough that the result is a tint a body of text can sit on, low enough that the
 * accent is still recognisable in it.
 */
const SUBTLE_MIX = 0.86;

/** Ramp used when a derived colour has to be pushed until it clears a threshold. */
const RAMP_STEPS = [0.12, 0.24, 0.36, 0.5, 0.64, 0.78, 1] as const;

/**
 * Every tenant-owned custom property, for one theme, as concrete hex.
 *
 * The caller emits these on `:root` (light) and `[data-theme='dark']` (dark). No
 * component branches on the theme, and no component reads `branding` — which is
 * what keeps the whole identity swappable by replacing this one block.
 */
export function brandCssVariables(
  branding: TenantBranding,
  theme: BrandTheme,
): Record<BrandTokenName, string> {
  const ground = THEME_GROUND[theme];
  const accent = normaliseHex(branding.primaryColor);
  const subtle = mix(accent, ground.surface, SUBTLE_MIX);

  return {
    '--color-accent': accent,
    '--color-accent-hover': mix(accent, theme === 'light' ? '#000000' : '#ffffff', HOVER_SHIFT),
    '--color-accent-subtle': subtle,
    '--color-on-accent': onAccentFor(accent),
    '--color-on-accent-subtle': readableOn(accent, subtle, AA_TEXT_CONTRAST),
    '--color-focus-ring': focusRingFor(accent, ground),
    '--color-brand-decor': normaliseHex(branding.accentColor),
  };
}

/**
 * The text colour to draw on `accent`: whichever candidate contrasts hardest.
 *
 * Computed rather than assumed. "White on the brand colour" is the guess that
 * makes a pale-yellow tenant's buttons unreadable, and it is the first thing a
 * tenant picks that the design system did not anticipate.
 */
export function onAccentFor(accent: string): string {
  const target = normaliseHex(accent);
  let best: string = ON_ACCENT_CANDIDATES[0];
  let bestRatio = 0;

  for (const candidate of ON_ACCENT_CANDIDATES) {
    const ratio = contrastRatio(candidate, target);

    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }

  return best;
}

/**
 * Contrast between two hex colours, WCAG 2.x definition. Exported because the
 * settings screen tells an admin what their colour actually scores rather than
 * silently correcting it.
 */
export function contrastRatio(left: string, right: string): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Branding with every absent value filled in.
 *
 * The API substitutes the same defaults, so this is the answer for the one case
 * it cannot cover: the branding read failed and the shell still has to render. A
 * tenant that has configured nothing looks like the platform rather than like a
 * bug.
 */
export function withBrandingDefaults(branding: Partial<TenantBranding> | null): TenantBranding {
  return {
    productName: branding?.productName ?? BRANDING_DEFAULTS.productName,
    primaryColor: branding?.primaryColor ?? BRANDING_DEFAULTS.primaryColor,
    accentColor: branding?.accentColor ?? BRANDING_DEFAULTS.accentColor,
    supportEmail: branding?.supportEmail ?? null,
    logo: branding?.logo ?? null,
    favicon: branding?.favicon ?? null,
  };
}

/**
 * A focus indicator that clears 3:1 against the theme's canvas (SC 1.4.11).
 *
 * The accent is stepped **away from the canvas** — toward black in the light
 * theme, toward white in the dark one. The contract's wording is "darkened",
 * which is right for the light theme and inverts the requirement for the dark
 * one, where darkening a colour against a near-black canvas destroys the
 * contrast it is trying to reach.
 */
function focusRingFor(accent: string, ground: ThemeGround): string {
  return (
    rampAwayFrom(accent, ground.canvas, FOCUS_INDICATOR_CONTRAST) ??
    // Unreachable while the canvas tokens are near-white and near-black — the
    // ramp's last step is the pure extreme. Kept because a future canvas token
    // is exactly the change that would make it reachable, and a focus ring that
    // silently stopped clearing 1.4.11 is not a failure anyone would see.
    ground.fallbackFocusRing
  );
}

/**
 * Text drawn on `background`, starting from `preferred` and stepping away until
 * it clears `threshold`.
 *
 * Falls back to the best pure candidate, which the three-candidate argument above
 * guarantees clears 4.5:1 for any background — so this function cannot return a
 * pair that fails.
 */
function readableOn(preferred: string, background: string, threshold: number): string {
  return rampAwayFrom(preferred, background, threshold) ?? onAccentFor(background);
}

/**
 * Mixes `colour` away from `from` in bounded steps, returning the first step that
 * clears `threshold` against it — or `null` if even the extreme does not.
 */
function rampAwayFrom(colour: string, from: string, threshold: number): string | null {
  const start = normaliseHex(colour);

  if (contrastRatio(start, from) >= threshold) {
    return start;
  }

  // Away from the background: toward black if the background is light, toward
  // white if it is dark. The direction is what makes one ramp serve both themes.
  const extreme = relativeLuminance(from) > 0.5 ? '#000000' : '#ffffff';

  for (const weight of RAMP_STEPS) {
    const stepped = mix(start, extreme, weight);

    if (contrastRatio(stepped, from) >= threshold) {
      return stepped;
    }
  }

  return null;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Linear interpolation in sRGB. Not perceptually uniform — a Lab or OKLCH mix
 * would be — but every result is checked against a real contrast threshold
 * afterwards, so uniformity buys nothing here and a colour-space dependency
 * would be a dependency this package does not otherwise need.
 */
function mix(from: string, to: string, weight: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  const at = (left: number, right: number) => Math.round(left + (right - left) * weight);

  return toHex({ r: at(a.r, b.r), g: at(a.g, b.g), b: at(a.b, b.b) });
}

function relativeLuminance(colour: string): number {
  const { r, g, b } = toRgb(colour);

  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function channelLuminance(value: number): number {
  const channel = value / 255;

  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * `#rrggbb` in, `{r,g,b}` out. `HexColorSchema` has already refused anything
 * else at the API boundary; this throws rather than guessing, because a silent
 * black would be a brand colour nobody chose.
 */
function toRgb(colour: string): Rgb {
  const hex = normaliseHex(colour);

  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((value) => clampByte(value).toString(16).padStart(2, '0')).join('')}`;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/** Lower-cased, so two spellings of one colour produce one token value. */
function normaliseHex(colour: string): string {
  const hex = colour.trim().toLowerCase();

  if (!HEX_COLOUR.test(hex)) {
    throw new RangeError(`Expected a #rrggbb hex colour, received ${JSON.stringify(colour)}`);
  }

  return hex;
}
