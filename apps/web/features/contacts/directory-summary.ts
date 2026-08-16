import type { Content } from '@/lib/content';

/**
 * The sentence above the contact directory.
 *
 * A pure function with its own tests, because this line is the one thing on the
 * page that makes a claim about contacts it cannot see. `loadContacts` reads one
 * page of `CONTACTS_PAGE_SIZE`, and rendering that page's length as a total is a
 * claim the read cannot support — a tenant with 200 contacts would be told it
 * has 25.
 *
 * Modelled on `features/assignment/flagged-summary.ts`, which solved the same
 * problem for the flagged queue. Same shape, same reasoning, deliberately not
 * shared: the two surfaces disagree about the empty case, because a directory
 * with a filter applied has something to say there and an unfiltered queue does
 * not.
 *
 * `null` means say nothing — an empty, untruncated directory is already
 * explained by the table's own empty state, and "0 contacts" above "No contacts
 * yet" is two sentences for one fact.
 */
export function contactsDirectorySummary(
  rowCount: number,
  hasMore: boolean,
  content: Content,
): string | null {
  if (hasMore) {
    // Names search rather than apologising, because search is the way through:
    // `q` is sent to the API, so it re-queries the whole tenant rather than
    // filtering the truncated page. A specific contact is always reachable;
    // what the cap costs is *browsing* past the first page.
    return content.contacts.showingFirst(rowCount);
  }

  return rowCount === 0 ? null : content.contacts.listCountDescription(rowCount);
}
