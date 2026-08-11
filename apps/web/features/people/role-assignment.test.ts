import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canChangeRoleOf,
  invitableRoles,
  type PeopleCaller,
} from './role-assignment';

/**
 * TAR-79's three role-assignment invariants, as the console applies them. These are
 * the escalation paths, so they are pinned here rather than left implicit in two
 * dialogs — and the API enforces the same three regardless.
 */

const ADMIN: PeopleCaller = { userId: 'admin-1', role: 'admin', canSetRole: true };
const SUPERVISOR: PeopleCaller = { userId: 'sup-1', role: 'supervisor', canSetRole: false };
const AGENT: PeopleCaller = { userId: 'agent-1', role: 'agent', canSetRole: false };

/**
 * Hypothetical: a supervisor who somehow held `user:set_role`. Invariant 2 has to
 * hold on its own, not merely because the current table gives `user:set_role` to
 * admins only — otherwise inserting a fourth role silently opens a path.
 */
const SUPERVISOR_WITH_SET_ROLE: PeopleCaller = { ...SUPERVISOR, canSetRole: true };

describe('invitableRoles — invariant 1', () => {
  it('caps a caller without user:set_role at agent, so they cannot mint an admin', () => {
    expect(invitableRoles(SUPERVISOR)).toEqual(['agent']);
    expect(invitableRoles(AGENT)).toEqual(['agent']);
  });

  it('lets an admin invite at any role up to their own', () => {
    expect(invitableRoles(ADMIN)).toEqual(['agent', 'supervisor', 'admin']);
  });

  it('still caps at the caller’s own seniority when they can set roles', () => {
    expect(invitableRoles(SUPERVISOR_WITH_SET_ROLE)).toEqual(['agent', 'supervisor']);
  });
});

describe('assignableRoles — invariant 2', () => {
  it('never offers a role above the caller’s own', () => {
    expect(assignableRoles(SUPERVISOR_WITH_SET_ROLE)).not.toContain('admin');
    expect(assignableRoles(ADMIN)).toContain('admin');
  });
});

describe('canChangeRoleOf — invariants 1 and 3', () => {
  it('refuses a caller without user:set_role', () => {
    expect(canChangeRoleOf(SUPERVISOR, 'someone-else')).toBe(false);
  });

  it('refuses a caller their own role, admin included', () => {
    // So every escalation needs a second person, and an admin cannot demote
    // themselves into a lockout.
    expect(canChangeRoleOf(ADMIN, ADMIN.userId)).toBe(false);
  });

  it('allows an admin to change someone else’s role', () => {
    expect(canChangeRoleOf(ADMIN, 'someone-else')).toBe(true);
  });
});
