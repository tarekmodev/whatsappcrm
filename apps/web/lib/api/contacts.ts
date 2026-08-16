import 'server-only';

import {
  ContactResponseSchema,
  type ContactListQuery,
  type ContactResponse,
  type ContactUpdateInput,
  type CursorPage,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * `GET/POST /api/v1/contacts` and `GET/PATCH /api/v1/contacts/{id}`, exactly as
 * 0002's endpoint table declares them. Reads need `contact:read`, writes
 * `contact:write`; both are enforced by the API and asserted again by the server
 * actions that call this.
 *
 * `POST` is deliberately absent. A contact is created by the ingest pipeline the
 * first time somebody messages the tenant (TAR-20) — the console has no screen
 * that invents one, and a resource function nothing calls is a route into the
 * product that nobody designed.
 */

const CONTACTS_PATH = '/v1/contacts';

export async function listContacts(query: ContactListQuery): Promise<CursorPage<ContactResponse>> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${CONTACTS_PATH}${toContactQueryString(query)}`,
  });

  return parseCursorPage(ContactResponseSchema, response);
}

export async function getContact(id: string): Promise<ContactResponse> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${CONTACTS_PATH}/${encodeURIComponent(id)}`,
  });

  return ContactResponseSchema.parse(response);
}

/**
 * Partial by construction, and `customFields` is a **merge** rather than a
 * replacement (0002 amendment 10): keys present are set, an explicit `null`
 * clears one, and keys absent are left alone. That is what stops an agent editing
 * one field from erasing every value their form did not happen to load.
 */
export async function updateContact(
  id: string,
  input: ContactUpdateInput,
): Promise<ContactResponse> {
  const response = await authenticatedRequest({
    method: 'PATCH',
    path: `${CONTACTS_PATH}/${encodeURIComponent(id)}`,
    body: input,
  });

  return ContactResponseSchema.parse(response);
}

function toContactQueryString(query: ContactListQuery): string {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  if (query.q !== undefined) {
    params.set('q', query.q);
  }

  if (query.tagId !== undefined) {
    params.set('tagId', query.tagId);
  }

  return `?${params.toString()}`;
}
