/**
 * Which rows arrived since the last render (TAR-517).
 *
 * The inbox is refreshed by `router.refresh()` when the socket says something
 * changed, so a conversation can appear at the top of the column while an agent
 * is reading it. Without a mark of some kind the whole queue silently reflows
 * under the cursor and the row they were about to click is now one lower.
 *
 * A pure function rather than a rule inside the list, so "the first render is
 * not an arrival" is a thing with a test rather than a condition somebody has to
 * spot inside a component.
 */

/**
 * `previous === null` is the list's first render: the whole page is arriving at
 * once, which is a page load and not an arrival. Nothing enters, so nothing
 * animates and the first paint is not spent on motion.
 *
 * Compared against the *previous render's* ids rather than everything ever seen,
 * so a conversation that left the filter and came back announces itself again —
 * which is exactly what it is doing — and nothing accumulates for the life of
 * the tab.
 */
export function enteringIds(
  previous: readonly string[] | null,
  next: readonly string[],
): ReadonlySet<string> {
  if (previous === null) {
    return new Set();
  }

  const before = new Set(previous);

  return new Set(next.filter((id) => !before.has(id)));
}
