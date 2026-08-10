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
    expect(agent.can('user:remove')).toBe(false);
    expect(agent.can('team:write')).toBe(false);
    expect(agent.can('report:read_all')).toBe(false);
  });

  it('refuses a supervisor the admin-only permissions', () => {
    const supervisor = checkerForRole('supervisor');

    expect(supervisor.can('team:write')).toBe(true);
    expect(supervisor.can('report:read_all')).toBe(true);
    // Editing and removing a user stays with the admin per the contract's table.
    expect(supervisor.can('user:update')).toBe(false);
    expect(supervisor.can('user:remove')).toBe(false);
    expect(supervisor.can('tenant:settings')).toBe(false);
  });

  it('canAll requires every permission, canAny only one', () => {
    const supervisor = checkerForRole('supervisor');

    expect(supervisor.canAny(['user:update', 'team:write'])).toBe(true);
    expect(supervisor.canAll(['user:update', 'team:write'])).toBe(false);
  });
});
