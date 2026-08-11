/** The shape Next hands a page for `?a=1&a=2`. */
export type RouteSearchParams = Record<string, string | string[] | undefined>;

/**
 * The first usable value for a query key, or `undefined`.
 *
 * A repeated key (`?tab=a&tab=b`) arrives as an array and a blank one as an empty
 * string; both mean "not set" to every reader in the app. Extracted once the
 * third page needed the identical five lines.
 */
export function firstSearchParam(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;

  return candidate === undefined || candidate.trim() === '' ? undefined : candidate;
}
