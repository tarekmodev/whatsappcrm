import type { AgentAvailability, TenantRole, UserStatus } from '@whatsappcrm/contracts';
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
};

export const AVAILABILITY_TONES: Record<AgentAvailability, BadgeTone> = {
  available: 'success',
  away: 'warning',
  offline: 'neutral',
};

export function roleOptions(roles: readonly TenantRole[]): SelectOption[] {
  return roles.map((role) => ({ value: role, label: content.roles[role] }));
}

export function userStatusOptions(statuses: readonly UserStatus[]): SelectOption[] {
  return statuses.map((status) => ({ value: status, label: content.userStatuses[status] }));
}
