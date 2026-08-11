/**
 * A byte count as a value and a unit key, ready for the content layer to phrase.
 *
 * Split rather than formatted here because the unit is *copy* — "KB" is not the
 * same string in every locale — while the arithmetic and the rounding are not.
 * The number is formatted with an explicit locale for the reason `RelativeTime`
 * pins one: a formatter that follows the runtime's locale renders one string on
 * the server and another in the browser, which is a hydration mismatch rather
 * than a nicety.
 */

export const FILE_SIZE_UNITS = ['bytes', 'kb', 'mb', 'gb'] as const;
export type FileSizeUnit = (typeof FILE_SIZE_UNITS)[number];

export interface FormattedFileSize {
  /** Already rounded and locale-formatted; render it as-is. */
  readonly value: string;
  readonly unit: FileSizeUnit;
}

const BYTES_PER_STEP = 1024;

/**
 * The locale the console formats numbers in until an i18n layer exists. One
 * constant rather than `undefined`, so server and client agree.
 */
const FORMATTING_LOCALE = 'en-GB';

export function formatFileSize(sizeBytes: number): FormattedFileSize {
  const safeBytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;

  let value = safeBytes;
  let step = 0;

  while (value >= BYTES_PER_STEP && step < FILE_SIZE_UNITS.length - 1) {
    value /= BYTES_PER_STEP;
    step += 1;
  }

  return {
    // Whole bytes; one decimal once it is a KB or more, where a rounded-down
    // "1 MB" for 1.9 MB would understate a document by half.
    value: new Intl.NumberFormat(FORMATTING_LOCALE, {
      maximumFractionDigits: step === 0 ? 0 : 1,
    }).format(value),
    unit: FILE_SIZE_UNITS[step] ?? 'bytes',
  };
}
