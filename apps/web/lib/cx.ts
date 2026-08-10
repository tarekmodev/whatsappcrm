/**
 * Joins CSS Module class names, dropping anything falsy. Small enough that
 * pulling in `clsx` would cost a dependency for four lines, and it keeps class
 * composition out of template strings — a concatenated class attribute is how
 * `undefined` ends up in the DOM.
 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => Boolean(value)).join(' ');
}
