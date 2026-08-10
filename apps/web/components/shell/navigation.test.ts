import { describe, expect, it } from 'vitest';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { checkerForRole } from '@/lib/session/permissions';
import { NAV_ITEMS, settingsNavItems, visibleNavItems } from './navigation';

/**
 * TAR-22, acceptance criteria 1 and 3, at the navigation layer:
 *
 *   - an agent sees no tenant-admin settings entry at all;
 *   - a supervisor sees the reporting/assignment entry;
 *   - an admin sees everything.
 *
 * Asserted against the contract's own role→permission table via `checkerForRole`,
 * so a change to `rbac.ts` shows up here rather than silently widening the UI.
 */

function navIdsFor(role: TenantRole): string[] {
  return flatten(visibleNavItems(NAV_ITEMS, checkerForRole(role)));
}

function flatten(items: ReturnType<typeof visibleNavItems>): string[] {
  return items.flatMap((item) => [item.id, ...flatten(item.children ?? [])]);
}

describe('navigation visibility by role', () => {
  it('gives an agent the inbox and nothing under settings', () => {
    const ids = navIdsFor('agent');

    expect(ids).toContain('inbox');
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('settings-people');
    expect(ids).not.toContain('settings-assignment');
  });

  it('gives a supervisor people management and the assignment report', () => {
    const ids = navIdsFor('supervisor');

    expect(ids).toContain('settings');
    expect(ids).toContain('settings-people');
    expect(ids).toContain('settings-assignment');
  });

  it('gives an admin every entry', () => {
    const ids = navIdsFor('admin');

    expect(ids).toEqual(
      expect.arrayContaining(['inbox', 'settings-people', 'settings-assignment']),
    );
  });

  it('drops a parent whose every child was filtered out', () => {
    // The agent case above proves the behaviour; this pins the mechanism, so a
    // future settings section cannot leave an empty "Settings" entry behind.
    expect(settingsNavItems(checkerForRole('agent'))).toHaveLength(0);
  });

  it('never renders an entry the role lacks every permission for', () => {
    for (const role of TENANT_ROLES) {
      const checker = checkerForRole(role);

      for (const item of visibleNavItems(NAV_ITEMS, checker)) {
        expect(checker.canAny(item.requiresAny)).toBe(true);
      }
    }
  });
});
