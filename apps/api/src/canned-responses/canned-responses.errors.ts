import { CANNED_RESPONSE_LIMITS } from '@whatsappcrm/contracts';

/**
 * Typed failures `CannedResponsesService` raises, mapped to error codes in
 * `canned-responses.http.ts`.
 *
 * Domain errors rather than `ApiException`s from the service layer, on
 * `assignment.errors.ts`' reasoning: the service is driven by fixtures and by
 * the integration suite as well as by HTTP, and neither of those has a response
 * to put a status on.
 *
 * 0011 adds **no new error code** — `not_found`, `conflict` and
 * `validation_failed` cover every refusal this surface has.
 */

/**
 * An id this tenant does not hold — absent, or belonging to another tenant.
 *
 * `not_found` for both, and that indistinguishability is the guarantee rather
 * than a convenience: row-level security means another tenant's row is simply
 * not visible, so the server genuinely cannot tell the two apart. A `403` would
 * confirm the id exists somewhere, which is exactly what `error-codes.ts`
 * refuses to do.
 */
export class CannedResponseNotFoundError extends Error {
  constructor(readonly cannedResponseId: string) {
    super(`No canned response ${cannedResponseId} in this tenant.`);
    this.name = 'CannedResponseNotFoundError';
  }
}

/**
 * `POST` or `PATCH` hitting `canned_responses (tenant_id, shortcut)`.
 *
 * The message says the comparison is case-insensitive, on
 * `AssignmentRuleNameTakenError`'s reasoning: `shortcut` is `citext`, so
 * `/Hours` collides with `/hours`, and "`/Hours` already exists" is confusing
 * when you typed `/hours`. (The grammar only accepts lowercase, so the stored
 * value a caller collides with is always the lowercase one — the note is there
 * for the reader of the code as much as for the supervisor.)
 *
 * `tenant_id` leads the unique index, so a conflict can only ever be caused by
 * this tenant's own row. That is what stops the constraint being usable as an
 * oracle for another tenant's shortcut namespace (0011, security, item 3).
 */
export class CannedResponseShortcutTakenError extends Error {
  constructor(readonly shortcut: string) {
    super(
      `A canned response for ${shortcut} already exists in this tenant. Shortcuts are ` +
        'case-insensitive.',
    );
    this.name = 'CannedResponseShortcutTakenError';
  }
}

/**
 * The cap on canned responses per tenant, reached on create.
 *
 * `conflict`, not `plan_limit_exceeded`, on `TooManyAssignmentRulesError`'s
 * reasoning (0011, error shapes): the cap is a property of the design — the
 * console downloads the whole set so it can resolve a typed shortcut without a
 * request per keystroke — not of the tenant's plan, and a `402` would send a
 * supervisor to the billing page to fix something money cannot.
 */
export class TooManyCannedResponsesError extends Error {
  constructor() {
    super(
      `This tenant already has ${CANNED_RESPONSE_LIMITS.perTenant} canned responses, which is ` +
        'the maximum. Delete or merge one before adding another.',
    );
    this.name = 'TooManyCannedResponsesError';
  }
}
