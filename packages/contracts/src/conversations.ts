import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { ContactResponseSchema } from './contacts';
import { CursorPageQuerySchema } from './pagination';

/**
 * The shared team inbox. A conversation is the durable thread between one tenant
 * WhatsApp number and one contact; tickets (see `tickets.ts`) hang off it rather
 * than replacing it. TAR-20 implements this.
 */

export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export const ConversationStatusSchema = z.enum(CONVERSATION_STATUSES);

export const ConversationResponseSchema = z.object({
  id: IdSchema,
  contact: ContactResponseSchema,
  /** Which of the tenant's WhatsApp numbers this thread belongs to. */
  whatsappAccountId: IdSchema,
  status: ConversationStatusSchema,
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  /** The open ticket for this thread, when one exists. */
  ticketId: IdSchema.nullable(),
  unreadCount: z.int().nonnegative(),
  /**
   * When the WhatsApp 24-hour customer service window closes. Past this instant
   * only approved templates may be sent. Denormalised onto the conversation
   * because every inbox row renders it, and recomputing per row costs a join.
   */
  serviceWindowExpiresAt: TimestampSchema.nullable(),
  /** True while the AI chatbot (TAR-28) is answering and no human has taken over. */
  botHandling: z.boolean(),
  lastMessagePreview: z.string().nullable(),
  /**
   * Never null: the column is `NOT NULL` (TAR-92) because it leads the inbox's
   * keyset index, and a null there silently drops rows from page two onward. A
   * conversation with no message yet carries its own `createdAt`, so a client
   * can sort and render every row without a null branch.
   */
  lastMessageAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * The inbox list. `assigned` is an agent's default view. A caller without
 * `conversation:read_all` may not widen `scope`, and the API silently narrows
 * rather than erroring — a supervisor's shared URL should still render for an
 * agent, just with less in it.
 */
export const ConversationListQuerySchema = CursorPageQuerySchema.extend({
  status: ConversationStatusSchema.optional(),
  scope: z.enum(['assigned', 'unassigned', 'all']).default('assigned'),
  assignedUserId: IdSchema.optional(),
  assignedTeamId: IdSchema.optional(),
  q: z.string().min(1).max(120).optional(),
});

export const ConversationAssignInputSchema = z
  .object({
    userId: IdSchema.nullable().optional(),
    teamId: IdSchema.nullable().optional(),
  })
  .refine((v) => v.userId !== undefined || v.teamId !== undefined, {
    message: 'Provide at least one of userId or teamId',
  });

export const ConversationStatusUpdateInputSchema = z.object({
  status: ConversationStatusSchema,
});

/**
 * Internal notes are never sent to the customer. They are a separate entity
 * rather than a message subtype specifically so that no send path can pick one
 * up by accident — the worst possible bug in this product.
 */
export const InternalNoteResponseSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  authorUserId: IdSchema,
  body: z.string().min(1).max(8000),
  /** Users @mentioned in the note; each receives a notification. */
  mentionedUserIds: z.array(IdSchema),
  createdAt: TimestampSchema,
});

export const InternalNoteCreateInputSchema = z.object({
  body: z.string().min(1).max(8000),
  mentionedUserIds: z.array(IdSchema).default([]),
});

export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;
export type ConversationAssignInput = z.infer<typeof ConversationAssignInputSchema>;
export type ConversationStatusUpdateInput = z.infer<typeof ConversationStatusUpdateInputSchema>;
export type InternalNoteResponse = z.infer<typeof InternalNoteResponseSchema>;
export type InternalNoteCreateInput = z.infer<typeof InternalNoteCreateInputSchema>;
