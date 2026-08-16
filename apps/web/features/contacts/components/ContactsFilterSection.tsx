import { loadTagVocabulary } from '../contacts.data';
import { ContactsFilterBar } from './ContactsFilterBar';

/**
 * Reads the tenant's tag vocabulary and hands it to the filter bar. Usage: inside
 * its own Suspense boundary on the contacts page, with `ContactsFilterBarSkeleton`
 * as the fallback.
 *
 * A boundary of its own rather than part of the list's, for two reasons: the tag
 * read must not delay the contacts the visitor came for, and a tenant whose tag
 * endpoint fails should still get a searchable directory rather than an error
 * card where the whole screen was.
 */
export async function ContactsFilterSection() {
  const { items, isTruncated } = await loadTagVocabulary();

  return <ContactsFilterBar tags={items} isTruncated={isTruncated} />;
}
