import { describe, expect, it } from 'vitest';
import { INBOX_FILTERS, INBOX_FILTERS_PRIMARY_COUNT, activeInboxFilterId } from './inbox-filters';

describe('inbox filters', () => {
  it('names the entry the current URL is on', () => {
    expect(activeInboxFilterId('unassigned', undefined)).toBe('unassigned');
    expect(activeInboxFilterId('assigned', undefined)).toBe('assigned');
    expect(activeInboxFilterId('all', 'open')).toBe('all-open');
    expect(activeInboxFilterId('all', undefined)).toBe('all');
  });

  it('marks nothing for a combination no entry names', () => {
    // Reachable by hand and by an older link. Highlighting the closest entry
    // would tell the reader they are somewhere they are not.
    expect(activeInboxFilterId('unassigned', 'resolved')).toBeNull();
  });

  it('keeps the primary set the three an agent opens the console for', () => {
    expect(INBOX_FILTERS.slice(0, INBOX_FILTERS_PRIMARY_COUNT).map((filter) => filter.id)).toEqual([
      'unassigned',
      'assigned',
      'all-open',
    ]);
  });

  it('offers no filter the list cannot answer', () => {
    // Every entry is a scope plus an optional status, which is exactly what
    // `GET /conversations` takes. An entry outside that is a dead link.
    for (const filter of INBOX_FILTERS) {
      expect(['assigned', 'unassigned', 'all']).toContain(filter.scope);
    }
  });
});
