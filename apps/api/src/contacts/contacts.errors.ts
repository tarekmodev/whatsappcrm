import { CUSTOM_FIELD_LIMITS, type ApiErrorDetail } from '@whatsappcrm/contracts';

/**
 * Typed failures the contacts services raise, mapped to error codes in
 * `contacts.http.ts`.
 *
 * Domain errors rather than `ApiException`s from the service layer, on
 * `people.errors.ts`' reasoning: these services are also driven by fixtures and
 * by unit tests, neither of which has an HTTP response to put a status on.
 *
 * 0002 amendment 10 adds no error code — `validation_failed`, `not_found` and
 * `conflict` cover every refusal on this surface.
 */

export class ContactNotFoundError extends Error {
  constructor(readonly contactId: string) {
    super(`No contact ${contactId} in this tenant.`);
    this.name = 'ContactNotFoundError';
  }
}

export class ContactPhoneTakenError extends Error {
  constructor(readonly phone: string) {
    super(
      `A contact with the number ${phone} already exists in this tenant. The phone number is the ` +
        'contact identity and cannot be held twice.',
    );
    this.name = 'ContactPhoneTakenError';
  }
}

export class CustomFieldNotFoundError extends Error {
  constructor(readonly customFieldId: string) {
    super(`No custom field ${customFieldId} in this tenant.`);
    this.name = 'CustomFieldNotFoundError';
  }
}

export class CustomFieldKeyTakenError extends Error {
  constructor(readonly key: string) {
    super(
      `A custom field with the key ${key} already exists in this tenant. Keys are unique because ` +
        'they name the value stored on every contact.',
    );
    this.name = 'CustomFieldKeyTakenError';
  }
}

/**
 * The cap on definitions per tenant, reached on create.
 *
 * `conflict`, not `plan_limit_exceeded`, on `TooManyAssignmentRulesError`'s
 * reasoning: the cap is a property of the surface — the definition list is
 * unpaginated and the routing-rule dropdown reads it whole — not of the tenant's
 * plan, and answering 402 would send an admin to the billing page to fix
 * something money cannot.
 */
export class TooManyCustomFieldsError extends Error {
  constructor() {
    super(
      `This tenant already has ${String(CUSTOM_FIELD_LIMITS.definitionsPerTenant)} custom fields, ` +
        'which is the maximum. Delete one before adding another.',
    );
    this.name = 'TooManyCustomFieldsError';
  }
}

/**
 * `reorder` was given something other than the tenant's current definition set.
 *
 * `customFieldIds` is the whole set rather than a delta, which buys optimistic
 * concurrency for free: a set that does not match exactly means another admin
 * added or deleted a field since this client loaded the page, and the honest
 * answer is `conflict` rather than a silent partial reorder.
 */
export class CustomFieldSetChangedError extends Error {
  constructor() {
    super(
      'The custom field list changed since you loaded it — somebody added or removed a field. ' +
        'Reload and reorder again.',
    );
    this.name = 'CustomFieldSetChangedError';
  }
}

/**
 * Delete refused because a routing rule's `contact_attribute` condition names
 * the key (0002 amendment 10).
 *
 * A rule whose condition can never match again is the silent-failure shape the
 * amendment refuses everywhere: routing that quietly matches nothing looks like
 * routing that works. The offending rules are named so the admin can disable
 * them and retry, rather than being told only that something objects.
 */
export class CustomFieldInUseByRulesError extends Error {
  constructor(
    readonly key: string,
    readonly rules: readonly { id: string; name: string }[],
  ) {
    super(
      `Routing rules still match on ${key}: ${rules.map((rule) => rule.name).join(', ')}. ` +
        'A rule naming a deleted field can never match again, so change or disable them first.',
    );
    this.name = 'CustomFieldInUseByRulesError';
  }
}

/**
 * A `customFields` write that the definition set refuses — an unknown key, or a
 * value that is not legal for its field's type.
 *
 * One error for both because they land the same way: `validation_failed` with
 * one `details` entry per offending key at path `customFields.<key>`, which is
 * the shape amendment 10 publishes. Carrying the details rather than a single
 * message is what lets the console mark the field the agent has to fix.
 */
export class CustomFieldValuesInvalidError extends Error {
  constructor(readonly issues: readonly ApiErrorDetail[]) {
    super(`Custom field values were refused: ${issues.map((issue) => issue.path).join(', ')}.`);
    this.name = 'CustomFieldValuesInvalidError';
  }
}

/**
 * `options` submitted for a type that cannot carry them, or omitted for `select`.
 *
 * `PATCH` accepts `options` without accepting `type`, so the schema cannot check
 * the pairing the way `CustomFieldDefinitionSchema` does on a whole definition —
 * only the service knows what the stored type is.
 */
export class CustomFieldOptionsMismatchError extends Error {
  constructor(readonly type: string) {
    super(
      type === 'select'
        ? 'A `select` field needs at least one option.'
        : `\`options\` is only meaningful for a \`select\` field, and this one is \`${type}\`.`,
    );
    this.name = 'CustomFieldOptionsMismatchError';
  }
}

/**
 * A stored `custom_field_defs.type` the published contract does not carry —
 * today that is only `multi_select`, which amendment 10 refuses at the edge and
 * deliberately leaves in the Postgres enum.
 *
 * Unreachable through this API, which is the only writer and validates on the
 * way in. Raised rather than mapped to `text` because publishing it as another
 * type would let an agent save a value the routing engine then reads under
 * different rules — a fault, so it reaches the caller as `internal_error` via
 * the untranslated path and lands in the log with the key that caused it.
 */
export class UnsupportedCustomFieldTypeError extends Error {
  constructor(
    readonly key: string,
    readonly type: string,
  ) {
    super(
      `Custom field ${key} has type ${type}, which this API does not publish. It cannot be ` +
        'rendered or validated without a contract change.',
    );
    this.name = 'UnsupportedCustomFieldTypeError';
  }
}
