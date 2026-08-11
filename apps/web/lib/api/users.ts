import 'server-only';

import {
  UserResponseSchema,
  type CursorPage,
  type InviteCreateInput,
  type UserListQuery,
  type UserResponse,
  type UserUpdateInput,
} from '@whatsappcrm/contracts';
import { apiRequest } from '@/lib/api/http';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * `GET/POST/PATCH/DELETE /api/v1/users*`, per TAR-39's endpoint table. No
 * component calls `fetch`; they call these, so the response shape is validated
 * against the contract in exactly one place per resource.
 */

const USERS_PATH = '/v1/users';

export async function listUsers(query: UserListQuery): Promise<CursorPage<UserResponse>> {
  const response = await apiRequest({
    method: 'GET',
    path: `${USERS_PATH}${toUserQueryString(query)}`,
  });

  return parseCursorPage(UserResponseSchema, response);
}

export async function inviteUser(input: InviteCreateInput): Promise<UserResponse> {
  const response = await apiRequest({
    method: 'POST',
    path: `${USERS_PATH}/invites`,
    body: input,
  });

  return UserResponseSchema.parse(response);
}

export async function updateUser(id: string, input: UserUpdateInput): Promise<UserResponse> {
  const response = await apiRequest({
    method: 'PATCH',
    path: `${USERS_PATH}/${encodeURIComponent(id)}`,
    body: input,
  });

  return UserResponseSchema.parse(response);
}

export async function removeUser(id: string): Promise<void> {
  await apiRequest({ method: 'DELETE', path: `${USERS_PATH}/${encodeURIComponent(id)}` });
}

function toUserQueryString(query: UserListQuery): string {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  if (query.role !== undefined) {
    params.set('role', query.role);
  }

  if (query.status !== undefined) {
    params.set('status', query.status);
  }

  if (query.teamId !== undefined) {
    params.set('teamId', query.teamId);
  }

  if (query.q !== undefined) {
    params.set('q', query.q);
  }

  return `?${params.toString()}`;
}
