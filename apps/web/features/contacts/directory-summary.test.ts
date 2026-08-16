import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { CONTACTS_PAGE_SIZE } from './constants';
import { contactsDirectorySummary } from './directory-summary';

/**
 * The line above the directory is the only thing on the page that makes a claim
 * about contacts it cannot see, so the cases that matter are the ones where the
 * page and the workspace disagree.
 */
describe('contactsDirectorySummary', () => {
  it('counts a complete directory', () => {
    expect(contactsDirectorySummary(3, false, content)).toBe(
      content.contacts.listCountDescription(3),
    );
  });

  it('says nothing at all when the directory is empty and complete', () => {
    // The table's empty state already explains it; "0 contacts" above
    // "No contacts yet" is two sentences for one fact.
    expect(contactsDirectorySummary(0, false, content)).toBeNull();
  });

  /**
   * The finding this module exists for: a tenant with 200 contacts was told it
   * had 25, and a supervisor filtering by a tag 60 contacts hold was told the
   * same — with nothing on screen saying so.
   */
  it('admits truncation instead of reporting the page as a total', () => {
    const line = contactsDirectorySummary(CONTACTS_PAGE_SIZE, true, content);

    expect(line).toBe(content.contacts.showingFirst(CONTACTS_PAGE_SIZE));
    expect(line).not.toBe(content.contacts.listCountDescription(CONTACTS_PAGE_SIZE));
  });

  it('points at search rather than apologising, because search is the way through', () => {
    // `q` is sent to the API, so it re-queries the whole workspace rather than
    // filtering this page — a specific contact stays reachable past the cap.
    expect(contactsDirectorySummary(CONTACTS_PAGE_SIZE, true, content)).toContain('Search');
  });

  it('never says "1 contact" for a truncated page of one', () => {
    // Reachable when the API's page size and this constant disagree. A count is
    // the one thing a truncated read may not claim, however small it is.
    expect(contactsDirectorySummary(1, true, content)).toBe(content.contacts.showingFirst(1));
  });
});
