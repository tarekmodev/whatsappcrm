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
 *
 * The one entry every role reaches is Security (TAR-61): a password screen gated
 * on a permission would be a password nobody without that permission can change.
 */

function navIdsFor(role: TenantRole): string[] {
  return flatten(visibleNavItems(NAV_ITEMS, checkerForRole(role)));
}

function flatten(items: ReturnType<typeof visibleNavItems>): string[] {
  return items.flatMap((item) => [item.id, ...flatten(item.children ?? [])]);
}

describe('navigation visibility by role', () => {
  it('gives an agent the inbox and no tenant-admin settings section', () => {
    const ids = navIdsFor('agent');

    expect(ids).toContain('inbox');
    expect(ids).not.toContain('settings-people');
    expect(ids).not.toContain('settings-assignment');
  });

  it('gives every role their own security section, and only that one for an agent', () => {
    for (const role of TENANT_ROLES) {
      expect(navIdsFor(role)).toContain('settings-security');
    }

    expect(settingsNavItems(checkerForRole('agent')).map((item) => item.id)).toEqual([
      'settings-security',
    ]);
  });

  it('gives a supervisor people management and the assignment report', () => {
    const ids = navIdsFor('supervisor');

    expect(ids).toContain('settings');
    expect(ids).toContain('settings-people');
    expect(ids).toContain('settings-assignment');
  });

  /**
   * TAR-169: the WhatsApp connection surface is gated on `channel:manage`, which
   * the contract's table gives to admin alone. A supervisor never sees a link to
   * a page whose only action the API would refuse.
   */
  it('keeps the WhatsApp connection surface to the role that may connect one', () => {
    expect(navIdsFor('admin')).toContain('settings-whatsapp');
    expect(navIdsFor('supervisor')).not.toContain('settings-whatsapp');
    expect(navIdsFor('agent')).not.toContain('settings-whatsapp');
  });

  it('gives an admin every entry', () => {
    const ids = navIdsFor('admin');

    expect(ids).toEqual(
      expect.arrayContaining([
        'inbox',
        'settings-people',
        'settings-assignment',
        'settings-whatsapp',
      ]),
    );
  });

  it('drops a parent whose every child was filtered out', () => {
    // Pins the mechanism independently of the real table, so a future settings
    // section cannot leave an empty "Settings" entry behind.
    const parent = {
      id: 'parent',
      label: 'Parent',
      href: '/parent',
      requiresAny: ['user:invite'],
      children: [
        { id: 'child', label: 'Child', href: '/parent/child', requiresAny: ['user:invite'] },
      ],
    } as const;

    expect(visibleNavItems([parent], checkerForRole('agent'))).toHaveLength(0);
  });

  it('never renders an entry the role lacks every permission for', () => {
    for (const role of TENANT_ROLES) {
      const checker = checkerForRole(role);

      for (const item of visibleNavItems(NAV_ITEMS, checker)) {
        // `undefined` is "everyone", which is a decision made in the table rather
        // than a permission to check — see `NavItem.requiresAny`.
        expect(item.requiresAny === undefined || checker.canAny(item.requiresAny)).toBe(true);
      }
    }
  });
});
