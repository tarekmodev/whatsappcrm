import { afterEach, describe, expect, it } from 'vitest';
import { forwardArrowStep, readingDirection } from './reading-direction';

afterEach(() => {
  document.documentElement.removeAttribute('dir');
  document.body.replaceChildren();
});

function mount(dir?: string): HTMLElement {
  const element = document.createElement('div');

  if (dir !== undefined) {
    element.setAttribute('dir', dir);
  }

  document.body.append(element);

  return element;
}

describe('readingDirection', () => {
  it('reads left to right by default', () => {
    expect(readingDirection(mount())).toBe('ltr');
  });

  it('reads the element’s own dir', () => {
    expect(readingDirection(mount('rtl'))).toBe('rtl');
  });

  /*
   * The case that matters in the app: `dir` is set once on `<html>` by the root
   * layout and every widget below it inherits. A helper that only looked at the
   * element's own attribute would report `ltr` for the entire console.
   */
  it('inherits the document’s direction', () => {
    document.documentElement.setAttribute('dir', 'rtl');

    expect(readingDirection(mount())).toBe('rtl');
  });

  /* A subtree may opt back out — an English form inside an Arabic console. */
  it('lets a subtree override the document', () => {
    document.documentElement.setAttribute('dir', 'rtl');

    expect(readingDirection(mount('ltr'))).toBe('ltr');
  });
});

describe('forwardArrowStep', () => {
  it('sends ArrowRight forwards where reading runs that way', () => {
    expect(forwardArrowStep(mount())).toBe(1);
  });

  it('sends ArrowRight backwards under RTL', () => {
    expect(forwardArrowStep(mount('rtl'))).toBe(-1);
  });
});
