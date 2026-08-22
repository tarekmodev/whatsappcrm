import { describe, expect, it } from 'vitest';
import { CANNED_RESPONSE_PREVIEW_LENGTH } from './constants';
import { previewBody } from './presentation';

/**
 * What a 4 kB saved reply looks like in a table cell. The point of cutting the
 * string rather than hiding the overflow is that the visible text and the
 * announced text are then the same one.
 */

describe('previewBody', () => {
  it('leaves a short body alone and says it was not cut', () => {
    expect(previewBody('Back in five minutes.')).toEqual({
      text: 'Back in five minutes.',
      isTruncated: false,
    });
  });

  it('collapses newlines, because a table cell is one paragraph', () => {
    expect(previewBody('Hi there,\n\nThanks for waiting.').text).toBe(
      'Hi there, Thanks for waiting.',
    );
  });

  it('cuts a long body to the preview budget and reports it', () => {
    const preview = previewBody('word '.repeat(200));

    expect(preview.isTruncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(CANNED_RESPONSE_PREVIEW_LENGTH + 1);
  });

  it('cuts on a word boundary rather than mid-word', () => {
    const preview = previewBody(`${'alpha beta '.repeat(30)}end`);

    expect(preview.text).toMatch(/(alpha|beta)…$/);
  });

  it('cuts a single unbroken word where it stands', () => {
    // No space to cut at. Cutting mid-word beats rendering four kilobytes.
    const preview = previewBody('x'.repeat(CANNED_RESPONSE_PREVIEW_LENGTH * 2));

    expect(preview.text).toBe(`${'x'.repeat(CANNED_RESPONSE_PREVIEW_LENGTH)}…`);
  });

  it('does not cut a body that is exactly the budget', () => {
    const exact = 'y'.repeat(CANNED_RESPONSE_PREVIEW_LENGTH);

    expect(previewBody(exact)).toEqual({ text: exact, isTruncated: false });
  });
});
