import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The bar's geometry, asserted against the module file rather than against a
 * render, because the defect it stands guard over is layout and jsdom has none.
 * Same idiom as `tokens.test.ts` — assert the CSS source, not a copy of its
 * values.
 *
 * Two rules, from two stories:
 *
 *   * **TAR-652.** The bar is a flex item of a column pinned to `100dvh` on a
 *     fill-mode route, so flex will shrink it back below the rows it paints.
 *     `main` is the item that gives way; the bar refuses.
 *   * **TAR-522.** It is one `--size-bar` row at every width. It used to wrap
 *     into three below 48rem — 161.4px of an 844px screen — and the overflowing
 *     search line landed on the inbox's filter disclosure and took its taps.
 *     Nothing about that is fixable while the bar is allowed to wrap.
 */

const css = readModuleFile('AppTopBar.module.css');

/**
 * The name arrives as a variable rather than a literal on purpose: Vite rewrites
 * a literal `new URL('./x', import.meta.url)` into an asset URL, and
 * `fileURLToPath` then rejects it. Same reason `tokens.test.ts` reads its files
 * through a parameter.
 */
function readModuleFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

/** The `.bar` rule's body, up to the first nested-free closing brace. */
function barRule(): string {
  const start = css.indexOf('.bar {');
  expect(start, 'AppTopBar.module.css has a .bar rule').toBeGreaterThan(-1);

  const end = css.indexOf('}', start);

  return css.slice(start, end);
}

describe('the top bar', () => {
  it('refuses to shrink below the rows it paints', () => {
    expect(barRule()).toMatch(/flex-shrink:\s*0;/);
  });

  it('never wraps, at any width', () => {
    expect(barRule()).not.toMatch(/flex-wrap:\s*wrap/);
  });

  it('is one row of exactly the bar token, plus the device inset', () => {
    expect(barRule()).toMatch(
      /min-block-size:\s*calc\(var\(--size-bar\) \+ env\(safe-area-inset-top\)\);/,
    );
    // Block padding would add to the 44px controls and overshoot the token.
    expect(barRule()).toMatch(/padding-block:\s*0;/);
  });

  it('keeps the account menu in the bar at every width', () => {
    const start = css.indexOf('.account {');
    expect(start, 'AppTopBar.module.css has an .account rule').toBeGreaterThan(-1);
    expect(css.slice(start, css.indexOf('}', start))).not.toMatch(/display:\s*none/);
  });

  /*
   * TAR-521 put a mark in front of the wordmark and took the lockup from the
   * 142px TAR-522 measured to 181px, against the 150px this slot has at 480px.
   * A non-shrinking flex item does not answer that by getting narrower — it
   * draws over the search icon beside it, which is an overlap rather than an
   * overflow and therefore invisible to a scroll-width check.
   */
  it('lets the wordmark truncate rather than overlap the control beside it', () => {
    expect(brandRule()).toMatch(/flex:\s*0 1 auto;/);
    // The other half: without this the automatic minimum is the whole `nowrap`
    // wordmark, and a flex item that may shrink but has nothing to give does not.
    expect(brandRule()).toMatch(/min-inline-size:\s*0;/);
  });
});

/**
 * And what stops the shrinking at the mark, asserted where it lives. If this ever
 * becomes shrinkable the bar's lockup can collapse to nothing at a width nobody
 * checked — the failure the rule above would otherwise have introduced.
 */
describe('the lockup inside it', () => {
  const lockupCss = readModuleFile('../brand/BrandLockup.module.css');

  it('keeps its mark whatever the bar takes away', () => {
    const start = lockupCss.indexOf('.mark {');
    expect(start, 'BrandLockup.module.css has a .mark rule').toBeGreaterThan(-1);
    expect(lockupCss.slice(start, lockupCss.indexOf('}', start))).toMatch(/flex:\s*0 0 auto;/);
  });
});

/** The `.brand` rule's body — the link the lockup sits inside. */
function brandRule(): string {
  const start = css.indexOf('.brand {');
  expect(start, 'AppTopBar.module.css has a .brand rule').toBeGreaterThan(-1);

  return css.slice(start, css.indexOf('}', start));
}
