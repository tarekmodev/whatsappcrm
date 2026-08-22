import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { brandCssVariables, contrastRatio } from '@whatsappcrm/contracts';

/**
 * The contrast guarantees `docs/design/0001-visual-design-language.md` publishes,
 * asserted against the token files themselves rather than against a copy of their
 * values.
 *
 * 0001 says "re-measure before changing any of them", and before TAR-514 the only
 * thing enforcing that was whoever remembered. The dark theme had drifted: the
 * `*-subtle` roles a status chip renders on were mid-scale saturated primitives,
 * so a chip out-shouted the primary button beside it.
 *
 * Two properties, and the second is the one a tenant brand can break:
 *
 *   1. **Text on a chip clears AA.** Every `--color-on-*-subtle` on its
 *      `--color-*-subtle`, in both themes, at 4.5:1.
 *   2. **A chip stands off the surface less than the accent does.** That is the
 *      hierarchy rule stated as arithmetic, and it is deliberately about
 *      *lightness and chroma* rather than hue — which is what keeps it true for a
 *      blue-branded tenant whose accent is the same hue as the `info` chip.
 */

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** The five chip tones. `accent` is here too: `Badge` renders it like the rest. */
const CHIP_TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const;

const AA_TEXT_CONTRAST = 4.5;

const tokens = readTokens();

describe('token contrast', () => {
  describe.each(THEMES)('%s theme', (theme) => {
    it.each(CHIP_TONES)('%s chip text clears AA on its own tint', (tone) => {
      const tint = token(theme, `--color-${tone}-subtle`);
      const text = token(theme, `--color-on-${tone}-subtle`);

      expect(contrastRatio(text, tint)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    });

    it('keeps every chip tint quieter than the accent it sits beside', () => {
      const surface = token(theme, '--color-surface');
      const accentStandOff = contrastRatio(token(theme, '--color-accent'), surface);

      for (const tone of CHIP_TONES) {
        const standOff = contrastRatio(token(theme, `--color-${tone}-subtle`), surface);

        expect(standOff, `--color-${tone}-subtle against the surface`).toBeLessThan(accentStandOff);
      }
    });

    /*
     * TAR-518's two roles. The note surface carries body copy, so it is held to
     * the same 4.5:1 a chip is; the failure colour is text *on a bubble*, and
     * the bubble it lands on is the outbound one — never `surface`, which is
     * what a naive measurement would have checked and passed.
     */
    it('keeps an internal note readable on its own surface', () => {
      expect(
        contrastRatio(token(theme, '--color-on-note'), token(theme, '--color-note')),
      ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    });

    it.each(['--color-accent-subtle', '--color-surface-sunken', '--color-surface'])(
      'keeps a failed delivery readable on %s',
      (surfaceRole) => {
        expect(
          contrastRatio(token(theme, '--color-delivery-failed'), token(theme, surfaceRole)),
        ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
      },
    );

    it('gives every chip tint the same weight, so no status shouts', () => {
      const surface = token(theme, '--color-surface');
      const standOffs = CHIP_TONES.map((tone) =>
        contrastRatio(token(theme, `--color-${tone}-subtle`), surface),
      );

      // A quarter of a contrast step. Wide enough that a hue's own luminance
      // does not have to be faked, tight enough that no chip reads as a fill.
      expect(Math.max(...standOffs) - Math.min(...standOffs)).toBeLessThan(0.25);
    });
  });
});

/**
 * TAR-29 lets a tenant replace the accent, and TAR-514's re-verification found
 * the seeded workspace resolving it to a blue — the same hue as the `info` chip.
 * A fix that separated chips from *green* would have re-broken on that tenant, so
 * the property is swept across the hue wheel rather than checked on the default.
 */
describe('the hierarchy survives a tenant brand', () => {
  const BRAND_HUES = [
    '#069c68', // The platform's own green.
    '#0f6fde', // The seeded workspace's blue — the hue that exposed this.
    '#a16207',
    '#b3261e',
    '#7c3aed',
    '#0891b2',
    '#db2777',
    '#4d7c0f',
  ];

  it.each(BRAND_HUES)('%s accent stays louder than every chip', (primaryColor) => {
    for (const theme of THEMES) {
      const branded = brandCssVariables(
        {
          productName: 'Test',
          primaryColor,
          accentColor: primaryColor,
          supportEmail: null,
          logo: null,
          favicon: null,
        },
        theme,
      );
      const surface = token(theme, '--color-surface');
      const accentStandOff = contrastRatio(branded['--color-accent'], surface);

      // `accent` excluded: the tenant owns that role, so its chip moves with the
      // button. The platform's status chips are what must stay underneath.
      for (const tone of CHIP_TONES.filter((candidate) => candidate !== 'accent')) {
        const standOff = contrastRatio(token(theme, `--color-${tone}-subtle`), surface);

        expect(standOff, `${theme} --color-${tone}-subtle under ${primaryColor}`).toBeLessThan(
          accentStandOff,
        );
      }
    }
  });
});

/**
 * TAR-519's chart series, and the three properties a two-series chart needs.
 *
 * The bug this replaces was the same class as TAR-514's: one series was taking
 * `--color-accent`, so a workspace whose brand resolved to blue drew `Opened` and
 * `Resolved` as two shades of one hue. A chart whose series cannot be told apart
 * is a chart with no series at all.
 *
 * The fix is a fixed palette, and these assertions are what keeps it fixed —
 * particularly the last one, which fails the moment somebody aliases a series
 * back to a role a tenant owns.
 */
describe('the chart series', () => {
  /** WCAG 2.2 SC 1.4.11: a graphic that carries meaning against its background. */
  const GRAPHIC_CONTRAST = 3;
  /**
   * How far apart the two series must sit in *lightness*, over and above their
   * hue difference. A colour-blind reader, a greyscale print and a projector all
   * lose the hue; none of them loses this.
   */
  const SERIES_SEPARATION = 1.8;

  describe.each(THEMES)('%s theme', (theme) => {
    it.each(['--color-chart-1', '--color-chart-2'])('draws %s clear of the surface', (role) => {
      expect(
        contrastRatio(token(theme, role), token(theme, '--color-surface')),
      ).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
    });

    it('separates the two series by lightness, not only by hue', () => {
      expect(
        contrastRatio(token(theme, '--color-chart-1'), token(theme, '--color-chart-2')),
      ).toBeGreaterThanOrEqual(SERIES_SEPARATION);
    });

    it.each(['--color-chart-1', '--color-chart-2'])('keeps %s off the accent', (role) => {
      // Not a contrast assertion: the point is that the series is not the role a
      // tenant replaces. A brand that happens to land on this blue is fine — the
      // chart draws no accent — but a series *aliased* to the accent is the bug.
      expect(token(theme, role)).not.toBe(token(theme, '--color-accent'));
    });
  });

  it('is not a role a tenant brand can move', () => {
    const branded = brandCssVariables(
      {
        productName: 'Test',
        primaryColor: '#0f6fde',
        accentColor: '#0f6fde',
        supportEmail: null,
        logo: null,
        favicon: null,
      },
      'light',
    );

    expect(Object.keys(branded).filter((name) => name.startsWith('--color-chart'))).toEqual([]);
  });
});

/**
 * One role's value in one theme. Throws rather than returning `undefined`: a
 * role this file asks for and the token layer does not declare is the failure
 * these tests exist to catch, and it should not arrive as `NaN` in a ratio.
 */
function token(theme: Theme, name: string): string {
  const value = tokens[theme][name];

  if (value === undefined) {
    throw new RangeError(`${name} is not declared for the ${theme} theme`);
  }

  return value;
}

/**
 * The token files, resolved to concrete hex per theme.
 *
 * A deliberately small CSS reader rather than a parser dependency: these two
 * files are plain custom-property declarations, and the failure mode that
 * matters — a role pointing at a primitive that does not exist — surfaces as an
 * undefined lookup, which the assertions above name.
 */
function readTokens(): Record<Theme, Record<string, string>> {
  const declarations = [
    ...blocksOf(readTokenFile('primitives.css')),
    ...blocksOf(readTokenFile('semantic.css')),
  ];

  const resolve = (theme: Theme): Record<string, string> => {
    const raw: Record<string, string> = {};

    for (const block of declarations) {
      if (block.selector.includes("[data-theme='dark']") && theme !== 'dark') {
        continue;
      }

      Object.assign(raw, block.declarations);
    }

    return Object.fromEntries(
      Object.entries(raw).map(([name, value]) => [name, resolveValue(value, raw)]),
    );
  };

  return { light: resolve('light'), dark: resolve('dark') };
}

function readTokenFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8').replaceAll(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
}

interface TokenBlock {
  readonly selector: string;
  readonly declarations: Record<string, string>;
}

/** Every `selector { --name: value; … }` block, in source order. */
function blocksOf(css: string): TokenBlock[] {
  const blocks: TokenBlock[] = [];

  for (const [, selector = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Record<string, string> = {};

    for (const declaration of body.split(';')) {
      const [name = '', ...rest] = declaration.split(':');

      if (name.trim().startsWith('--')) {
        declarations[name.trim()] = rest.join(':').trim();
      }
    }

    blocks.push({ selector: selector.trim(), declarations });
  }

  return blocks;
}

function resolveValue(value: string, raw: Record<string, string>, depth = 0): string {
  const reference = /^var\((--[\w-]+)\)$/.exec(value.trim());

  if (reference === null) {
    return value.trim();
  }

  const name = reference[1] ?? '';

  if (depth > 10) {
    throw new RangeError(`Custom property ${name} resolves in a cycle`);
  }

  const target = raw[name];

  if (target === undefined) {
    throw new RangeError(`Custom property ${name} is referenced but never declared`);
  }

  return resolveValue(target, raw, depth + 1);
}
