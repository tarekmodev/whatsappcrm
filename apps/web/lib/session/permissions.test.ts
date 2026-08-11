import { describe, expect, it } from 'vitest';
import { allowedConversationScopes, checkerForRole } from './permissions';

/**
 * TAR-22, acceptance criterion 1: an agent's inbox is capped at their own and
 * their teams' conversations, so the UI must not offer them a wider scope.
 */
describe('allowedConversationScopes', () => {
  it('offers an agent only their assigned conversations', () => {
    expect(allowedConversationScopes(checkerForRole('agent'))).toEqual(['assigned']);
  });

  it('offers a supervisor the tenant-wide scopes', () => {
    expect(allowedConversationScopes(checkerForRole('supervisor'))).toEqual([
      'assigned',
      'unassigned',
      'all',
    ]);
  });

  it('offers an admin the tenant-wide scopes', () => {
    expect(allowedConversationScopes(checkerForRole('admin'))).toContain('all');
  });
});

describe('permission checker', () => {
  it('refuses an agent the tenant-admin permissions', () => {
    const agent = checkerForRole('agent');

    expect(agent.can('tenant:settings')).toBe(false);
    expect(agent.can('user:update')).toBe(false);
    expect(agent.can('user:set_role')).toBe(false);
    expect(agent.can('user:remove')).toBe(false);
    expect(agent.can('team:write')).toBe(false);
    expect(agent.can('report:read_all')).toBe(false);
  });

  it('lets a supervisor manage people without being able to promote anyone', () => {
    const supervisor = checkerForRole('supervisor');

    expect(supervisor.can('team:write')).toBe(true);
    expect(supervisor.can('report:read_all')).toBe(true);
    // TAR-79 granted `user:update` so a supervisor can suspend a departing
    // contractor and change team membership from the person's side.
    expect(supervisor.can('user:invite')).toBe(true);
    expect(supervisor.can('user:update')).toBe(true);
    // The whole point of the split: editing a person is not promoting them.
    // Without this, `user:update` would let a supervisor promote themselves.
    expect(supervisor.can('user:set_role')).toBe(false);
    // Deletion is irreversible and changes seat billing, so it stays with admin;
    // `status: 'suspended'` covers "cut their access now" and is reversible.
    expect(supervisor.can('user:remove')).toBe(false);
    expect(supervisor.can('tenant:settings')).toBe(false);
  });

  it('gives an admin both halves of the role-assignment split', () => {
    const admin = checkerForRole('admin');

    expect(admin.can('user:update')).toBe(true);
    expect(admin.can('user:set_role')).toBe(true);
    expect(admin.can('user:remove')).toBe(true);
  });

  it('canAll requires every permission, canAny only one', () => {
    const supervisor = checkerForRole('supervisor');

    expect(supervisor.canAny(['user:set_role', 'team:write'])).toBe(true);
    expect(supervisor.canAll(['user:set_role', 'team:write'])).toBe(false);
  });
});
