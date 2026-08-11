/**
 * Whether a nav or tab href is the one currently being viewed.
 *
 * Compares path segments only. An entry's href may carry default query
 * parameters (`/inbox?scope=assigned`), and those must not decide whether it is
 * current — otherwise the entry stops being marked the moment a filter changes.
 *
 * Shared by every strip of links that marks one of itself, so the rail, the
 * drawer and the tab strips cannot disagree about which one that is.
 */
export function isCurrentPath(pathname: string, href: string): boolean {
  const [target = ''] = href.split('?');

  return pathname === target || pathname.startsWith(`${target}/`);
}
