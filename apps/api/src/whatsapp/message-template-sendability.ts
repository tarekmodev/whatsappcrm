import type { MessageTemplateSendBlocker, MessageTemplateStatus } from '@whatsappcrm/contracts';
import type { MessageTemplateComponentSummary } from './message-template-components';

/**
 * Why a template the tenant holds is not in the composer's picker — one
 * predicate, read by both surfaces (TAR-91; 0002 amendment 8).
 *
 * ## Why this is a function and not two `if`s in two files
 *
 * `GET /api/v1/message-templates` drops a row on exactly two rules, and the
 * administration surface exists to *explain* the rows it dropped. Stated twice,
 * the two would eventually disagree — and the failure is silent in the worst
 * direction: a template missing from the picker and reported here as sendable
 * tells an administrator that the thing they are looking at is fine, which is
 * the one answer this surface must never give. So the exclusion is written once,
 * the picker filters on `blockers.length === 0`, and this surface publishes the
 * blockers. Adding a third exclusion is one change in one place, and the
 * explanation follows it automatically.
 *
 * ## What is deliberately not here
 *
 * A header format the composer cannot fill. TAR-91's acceptance criteria name
 * one, written when `SendTemplateInput` was still a flat variables array — but
 * amendment 1 gave the send contract its header slot and TAR-72 built the fields
 * for all five formats (`template-draft.ts` covers `text`, `image`, `video`,
 * `document` and `location`), so `MessageTemplateQueryService.list` filters on
 * no header format and there is no such exclusion left to explain. A blocker
 * that can never fire would be worse than none: it is a promise to an
 * administrator that this list is complete, kept by a branch nothing reaches.
 */
export function messageTemplateSendBlockers(
  status: MessageTemplateStatus,
  summary: MessageTemplateComponentSummary,
): MessageTemplateSendBlocker[] {
  const blockers: MessageTemplateSendBlocker[] = [];

  // Meta refuses a send on anything but `approved`, so this is Meta's answer and
  // not a product limit. Reported first because it is the one an administrator
  // can do something about, in Meta's own tooling.
  if (status !== 'approved') {
    blockers.push('meta_not_approved');
  }

  // Both, not one: a pending template with a dynamic-URL button stays out of the
  // picker after Meta approves it, and an administrator told only about the
  // approval would be waiting for something that does not finish the job.
  if (summary.requiresButtonParameters) {
    blockers.push('button_parameters_required');
  }

  return blockers;
}
