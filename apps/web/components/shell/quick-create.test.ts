import { describe, expect, it } from 'vitest';
import { QUICK_CREATE_ITEMS, visibleQuickCreateItems } from './quick-create';
import { checkerForRole } from '@/lib/session/permissions';

/**
 * The `+` offers links to surfaces that exist, filtered to what the principal
 * may actually do. An agent holds none of them, which is why `QuickCreateMenu`
 * renders nothing rather than an empty panel.
 */
describe('visibleQuickCreateItems', () => {
  it('gives an agent nothing to create', () => {
    expect(visibleQuickCreateItems(QUICK_CREATE_ITEMS, checkerForRole('agent'))).toEqual([]);
  });

  it('gives an admin every entry', () => {
    expect(
      visibleQuickCreateItems(QUICK_CREATE_ITEMS, checkerForRole('admin')).map((item) => item.id),
    ).toEqual(['invite-person', 'create-team', 'connect-whatsapp']);
  });

  it('points every entry at a route inside the app', () => {
    for (const item of QUICK_CREATE_ITEMS) {
      expect(item.href.startsWith('/')).toBe(true);
    }
  });
});
