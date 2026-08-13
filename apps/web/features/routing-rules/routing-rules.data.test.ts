import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorPageQuerySchema } from '@whatsappcrm/contracts';

/**
 * Regression guard for the read that decides whether a rule's target renders as a
 * person or as "a removed agent".
 *
 * Reading fewer agents than a tenant has does not truncate a list here — nothing
 * on this surface paginates — it makes the card assert a removal that never
 * happened. That is why the cap is pinned rather than left to whichever page size
 * happened to be imported.
 */

vi.mock('server-only', () => ({}));

const emptyPage = { items: [], nextCursor: null };

const listUsers = vi.fn(() => Promise.resolve(emptyPage));
const listTeams = vi.fn(() => Promise.resolve(emptyPage));
const listAssignmentRules = vi.fn(() => Promise.resolve([]));
const listTags = vi.fn(() => Promise.resolve([]));
const listCustomFieldDefinitions = vi.fn(() => Promise.resolve([]));

vi.mock('@/lib/api/users', () => ({ listUsers }));
vi.mock('@/lib/api/teams', () => ({ listTeams }));
vi.mock('@/lib/api/assignment-rules', () => ({ listAssignmentRules }));
vi.mock('@/lib/api/contact-schema', () => ({ listTags, listCustomFieldDefinitions }));

const { loadRoutingRules } = await import('./routing-rules.data');
const { VOCABULARY_LIMIT } = await import('./constants');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadRoutingRules', () => {
  it('reads the agent vocabulary at the vocabulary cap, not a table page size', () => {
    // The bug this pins: borrowing the People table's `AGENTS_PAGE_SIZE` (25)
    // meant a tenant with more agents than that had rules pointing at people the
    // surface could not name, and the card said they had been removed.
    expect(VOCABULARY_LIMIT).toBe(100);
  });

  it('asks for as many agents as one read is allowed to return', async () => {
    await loadRoutingRules();

    expect(listUsers).toHaveBeenCalledWith({ limit: VOCABULARY_LIMIT });
  });

  it('stays within the contract’s own ceiling for a list read', () => {
    // A cap above `CursorPageQuerySchema`'s max would be refused as
    // `validation_failed` and take the whole surface down rather than mislabel it.
    expect(CursorPageQuerySchema.safeParse({ limit: VOCABULARY_LIMIT }).success).toBe(true);
    expect(CursorPageQuerySchema.safeParse({ limit: VOCABULARY_LIMIT + 1 }).success).toBe(false);
  });

  it('resolves every vocabulary in one pass', async () => {
    await loadRoutingRules();

    for (const read of [
      listAssignmentRules,
      listTeams,
      listUsers,
      listTags,
      listCustomFieldDefinitions,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
});
