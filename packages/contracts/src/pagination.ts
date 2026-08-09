import { z } from 'zod';

/**
 * Cursor pagination is the default for every list endpoint. The inbox is an
 * append-heavy, constantly-shifting feed, where offset pagination skips and
 * duplicates rows as new messages arrive. TAR-39 confirms this across resources.
 */
export const CursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;

export interface CursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page; `null` when the caller has reached the end. */
  nextCursor: string | null;
}
