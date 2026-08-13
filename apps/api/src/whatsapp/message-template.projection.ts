import type { Prisma } from '../generated/prisma/client';
import type { MessageTemplateComponentSummary } from './message-template-components';

/**
 * Exactly the columns a template response is built from — nothing wider.
 *
 * One projection for both reads. `MessageTemplateAdminResponseSchema` extends
 * `MessageTemplateResponseSchema`, so the two surfaces publish the same columns
 * plus two derived fields; a second projection would be a second chance for one
 * of them to start selecting a column it does not return. `components` is the
 * expensive one here — a JSONB tree Meta sizes, not us — and it is selected
 * because both responses publish it verbatim and both derive from it.
 */
export const MESSAGE_TEMPLATE_PROJECTION = {
  id: true,
  whatsappBusinessAccountId: true,
  name: true,
  language: true,
  category: true,
  status: true,
  components: true,
  providerTemplateId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ListedMessageTemplate = Prisma.MessageTemplateGetPayload<{
  select: typeof MESSAGE_TEMPLATE_PROJECTION;
}>;

/**
 * A row with what its component tree says, read once. Every caller needs the
 * summary — the picker to apply the exclusion, the administration surface to
 * explain it, the send path to check arity — so it is derived where the row is
 * read and carried, rather than parsed again at each consumer.
 */
export interface ListedTemplate {
  row: ListedMessageTemplate;
  summary: MessageTemplateComponentSummary;
}
