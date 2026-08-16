import 'server-only';

import type { ContactResponse, CustomFieldDefinition } from '@whatsappcrm/contracts';
import { getContact, listContacts } from '@/lib/api/contacts';
import {
  listCustomFieldDefinitions,
  listTagVocabulary,
  type TagVocabulary,
} from '@/lib/api/contact-schema';
import { ApiRequestError } from '@/lib/api/http';
import { CONTACTS_PAGE_SIZE } from './constants';
import type { ContactListParams } from './contact-params';

/**
 * Server-side reads for the contacts surface. Everything a screen needs comes
 * from one pass on the server, so the client never fetches and tenant scoping is
 * decided where the session lives — the API derives it from the caller's cookie,
 * never from an id this process could pass.
 */

/**
 * The directory itself. Deliberately *not* joined with the tag vocabulary:
 * `ContactResponse` already carries the tags each contact holds, and the filter
 * bar reads the vocabulary in its own boundary — so a slow tag read never holds
 * up the list, and a failing one never blanks it.
 */
export interface ContactDirectory {
  readonly contacts: readonly ContactResponse[];
  /**
   * Whether the tenant holds contacts this page did not reach.
   *
   * Carried out rather than dropped, because the alternative is the section
   * rendering `contacts.length` as a total — "25 contacts" for a tenant with
   * 200, and at its most wrong exactly when the directory is most useful.
   * `contactsDirectorySummary` is what turns it into a sentence.
   */
  readonly hasMore: boolean;
}

export async function loadContacts(filters: ContactListParams): Promise<ContactDirectory> {
  const page = await listContacts({
    limit: CONTACTS_PAGE_SIZE,
    q: filters.q,
    tagId: filters.tagId,
  });

  return { contacts: page.items, hasMore: page.nextCursor !== null };
}

/**
 * The tenant's tag vocabulary, for the filter dropdown and the tag editor.
 *
 * Carries `isTruncated`: tags have no server-side cap, so a tenant past 100 gets
 * a short list — and a short list is what makes the profile label a live tag
 * "No longer available in this workspace".
 */
export async function loadTagVocabulary(): Promise<TagVocabulary> {
  return listTagVocabulary();
}

/**
 * One contact, plus everything the profile renders it against.
 *
 * A discriminated union rather than a throw, because "no contact by that id" is
 * a state the page draws — a shared link to a contact in another tenant, or one
 * a colleague merged away — and not an error card with a Retry that could never
 * succeed. Every other failure still propagates to the section's boundary.
 */
export type ContactProfileData =
  | {
      readonly status: 'found';
      readonly contact: ContactResponse;
      /** In `position` order, exactly as the profile form renders them. */
      readonly definitions: readonly CustomFieldDefinition[];
      /**
       * The vocabulary *and* whether it was truncated. The tag editor needs both:
       * a tag the contact holds but the vocabulary does not name is either
       * deleted or simply past the cap, and only `isTruncated` can tell those
       * apart. Labelling the second one "No longer available" is a lie about a
       * tag in daily use.
       */
      readonly tags: TagVocabulary;
    }
  | { readonly status: 'unavailable' };

export async function loadContactProfile(contactId: string): Promise<ContactProfileData> {
  try {
    // Independent reads: sequencing them would triple the profile's TTFB.
    const [contact, definitions, tags] = await Promise.all([
      getContact(contactId),
      listCustomFieldDefinitions(),
      listTagVocabulary(),
    ]);

    return { status: 'found', contact, definitions, tags };
  } catch (error) {
    // `not_found` only. The API answers it for a record in another tenant as
    // well as for one that does not exist — the two are indistinguishable by
    // design, so nothing can be enumerated across tenants.
    if (error instanceof ApiRequestError && error.code === 'not_found') {
      return { status: 'unavailable' };
    }

    throw error;
  }
}
