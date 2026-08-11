import { describe, expect, it } from 'vitest';
import { formatFileSize } from './file-size';

describe('formatFileSize', () => {
  it('leaves small files in whole bytes', () => {
    expect(formatFileSize(512)).toEqual({ value: '512', unit: 'bytes' });
  });

  it('steps up a unit at a time', () => {
    expect(formatFileSize(2_048)).toEqual({ value: '2', unit: 'kb' });
    expect(formatFileSize(5 * 1_024 * 1_024)).toEqual({ value: '5', unit: 'mb' });
  });

  it('keeps one decimal, so 1.9 MB does not read as 1 MB', () => {
    expect(formatFileSize(Math.round(1.9 * 1_024 * 1_024))).toEqual({ value: '1.9', unit: 'mb' });
  });

  it('treats a missing or nonsense size as zero rather than rendering NaN', () => {
    expect(formatFileSize(0)).toEqual({ value: '0', unit: 'bytes' });
    expect(formatFileSize(Number.NaN)).toEqual({ value: '0', unit: 'bytes' });
    expect(formatFileSize(-1)).toEqual({ value: '0', unit: 'bytes' });
  });

  it('formats with a fixed locale, so the server and the browser agree', () => {
    // A runtime-locale formatter would render `1,5` in one place and `1.5` in
    // the other, which is a hydration mismatch rather than a nicety.
    expect(formatFileSize(Math.round(1.5 * 1_024)).value).toBe('1.5');
  });
});
