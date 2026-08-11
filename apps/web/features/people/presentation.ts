import type {
  AgentAvailability,
  TenantRole,
  UserStatus,
  UserWritableStatus,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { BadgeTone } from '@/components/ui/Badge';
import type { SelectOption } from '@/components/ui/Select';

/**
 * Maps domain values onto presentation. Kept out of the components so the agents
 * table, the edit dialog and the assignment report all label a role identically —
 * and so a new role means editing one table.
 */

export const ROLE_TONES: Record<TenantRole, BadgeTone> = {
  agent: 'neutral',
  supervisor: 'info',
  admin: 'accent',
};

export const USER_STATUS_TONES: Record<UserStatus, BadgeTone> = {
  invited: 'warning',
  active: 'success',
  suspended: 'danger',
  // Soft-deleted. Neutral rather than `danger`: a removed account is a settled
  // outcome, not a problem to draw the eye to.
  removed: 'neutral',
};

export const AVAILABILITY_TONES: Record<AgentAvailability, BadgeTone> = {
  available: 'success',
  away: 'warning',
  offline: 'neutral',
};

export function roleOptions(roles: readonly TenantRole[]): SelectOption[] {
  return roles.map((role) => ({ value: role, label: content.roles[role] }));
}

/**
 * Deliberately typed to `UserWritableStatus`, not `UserStatus`. `PATCH /users/{id}`
 * accepts only `active` and `suspended`: `invited` is the invite flow's to set and
 * unset, and `removed` belongs to `DELETE`, which is gated on admin-only
 * `user:remove`. A picker offering either would be a side door around that
 * permission split, so the type makes one impossible to build.
 */
export function userStatusOptions(statuses: readonly UserWritableStatus[]): SelectOption[] {
  return statuses.map((status) => ({ value: status, label: content.userStatuses[status] }));
}
