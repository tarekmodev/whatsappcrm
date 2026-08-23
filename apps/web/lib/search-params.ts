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

/**
 * A search box's value as the URL carries it: trimmed, or absent when it holds
 * nothing but spaces.
 *
 * The same rule as `firstSearchParam` reads back, written from the other side.
 * Every filter bar held the identical ternary twice — once in its debounce and
 * once in the select beside it — and "blank means no `q`" belongs to the URL
 * contract rather than to any one bar.
 */
export function searchTermParam(value: string): string | undefined {
  const trimmed = value.trim();

  return trimmed === '' ? undefined : trimmed;
}
