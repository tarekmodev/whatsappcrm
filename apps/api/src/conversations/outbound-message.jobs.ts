import type { SendTemplateHeader } from '@whatsappcrm/contracts';
import type { TenantJobData } from '../queue/queue.service';

/**
 * The job that actually delivers an agent's reply.
 *
 * ## Keyed on the row, and carrying as little as it can
 *
 * `messageId` names a committed `messages` row, per TAR-39's rule that every
 * job names durable state rather than carrying it. The row is the statement of
 * intent — status `queued` — and this job is only how it gets acted on, which is
 * what makes a re-enqueue, a BullMQ retry and a crash all converge on one send.
 *
 * Everything the Cloud API call needs is therefore read back from the row and
 * its relations: the recipient from the conversation's contact, the number from
 * the conversation, the text from `body`, the file from the attachment. None of
 * it is duplicated here, so a customer's phone number and an agent's message
 * body do not also sit in Redis.
 *
 * ## Except a template's inputs, which have nowhere else to live
 *
 * `templateName`, `languageCode`, `variables` and `header` are the one part of a
 * send the schema has no column for. They ride in the payload, and that is a
 * real limitation rather than a design: if Redis loses the job, the message
 * stays `queued` and no retry can reconstruct it. The follow-up recorded with
 * the story is a sweep that fails an outbound message left `queued` past a
 * threshold, so an agent sees "not sent" instead of a reply that silently never
 * left — a persisted send request is the larger fix, and it is a data-model
 * change rather than this story's.
 *
 * The variables are a customer's own data — an order number, a name — so this
 * payload is as sensitive as the message it renders. It inherits Redis's
 * retention rather than choosing one: `removeOnComplete` clears it as soon as
 * the send succeeds.
 */
export interface SendOutboundMessageJob extends TenantJobData {
  /** Non-null: the message row exists, so the payload is already routed. */
  readonly tenantId: string;
  readonly messageId: string;
  /**
   * Present only for a template send, and only because there is no column for
   * it. Absent for text and media, which are fully reconstructible from the row.
   */
  readonly template?: OutboundTemplate;
}

export interface OutboundTemplate {
  readonly name: string;
  /** Meta's language tag for the approved template, e.g. `en_US`. */
  readonly languageCode: string;
  /** Positional BODY substitutions, already checked against the approved arity. */
  readonly variables: readonly string[];
  /** Present exactly when the approved template declares a header. */
  readonly header?: SendTemplateHeader;
}
