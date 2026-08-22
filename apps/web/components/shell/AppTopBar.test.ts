import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TAR-652, asserted against the module file rather than against a render.
 *
 * The defect is geometry: below 48rem the bar wraps onto more than one row, and
 * on a fill-mode route it is a flex item of a column pinned to `100dvh` — so
 * flex shrank it back below the rows it went on painting. The overflowing
 * search pill landed on the inbox's filter disclosure, and because the bar is
 * `position: sticky` above `--z-nav` it took the taps too: 40.4px of overlap at
 * 320x568, with the disclosure's own centre hit-testing to the search field.
 *
 * jsdom has no layout, so it cannot measure that; what it can hold is the one
 * declaration the measurement turned on. Same idiom as `tokens.test.ts` —
 * assert the CSS source, not a copy of its values.
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

  it('still wraps, which is what makes the shrink visible', () => {
    expect(barRule()).toMatch(/flex-wrap:\s*wrap;/);
  });
});
