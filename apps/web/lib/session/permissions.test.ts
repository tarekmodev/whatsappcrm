import { describe, expect, it } from 'vitest';
import { checkerForRole, isConversationScopeNarrowed } from './permissions';
import { INBOX_SCOPES } from '@/lib/routes';

/**
 * The inbox offers every scope to every role.
 *
 * This used to assert the opposite — TAR-22 capped an agent at `assigned`. ADR
 * 0002 amendment 4 then ruled that an unclaimed conversation is visible to every
 * agent on the tenant, and the API's `inboxScopeFilter` opens `unassigned`
 * accordingly, so a console that hid the tab would leave arriving customers
 * unanswered. What replaces the cap is the narrowing notice below.
 */
describe('inbox scopes', () => {
  it('offers all three scopes whatever the role', () => {
    expect(INBOX_SCOPES).toEqual(['assigned', 'unassigned', 'all']);
  });

  it('tells an agent that `all` is narrower than it sounds', () => {
    expect(isConversationScopeNarrowed(checkerForRole('agent'), 'all')).toBe(true);
  });

  it('does not claim a narrowing for a principal who may read every thread', () => {
    expect(isConversationScopeNarrowed(checkerForRole('supervisor'), 'all')).toBe(false);
    expect(isConversationScopeNarrowed(checkerForRole('admin'), 'all')).toBe(false);
  });

  it('never claims a narrowing for the scopes that mean the same to everyone', () => {
    const agent = checkerForRole('agent');

    expect(isConversationScopeNarrowed(agent, 'assigned')).toBe(false);
    expect(isConversationScopeNarrowed(agent, 'unassigned')).toBe(false);
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
