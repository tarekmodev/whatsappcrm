import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * Row → response. Explicit field by field, never a spread — the boundary that
 * stops a column reaching the API by accident (`people.mapper.ts`).
 *
 * One column is deliberately absent from both the projection and the response:
 * `is_shared`. It is `true` for every row a CHECK constraint will accept at v1,
 * so publishing it would be a field the console has to render and nobody can
 * change. The day personal responses are in scope it becomes a DTO field, and
 * the audience changes with it (0011, open question 3).
 */

/** Exactly the columns a `CannedResponseResponse` needs, and no others. */
export const CANNED_RESPONSE_PROJECTION = {
  id: true,
  shortcut: true,
  title: true,
  body: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CannedResponseSelect;

export interface CannedResponseRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toCannedResponseResponse(row: CannedResponseRow): CannedResponseResponse {
  return {
    id: row.id,
    shortcut: row.shortcut,
    title: row.title,
    body: row.body,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
