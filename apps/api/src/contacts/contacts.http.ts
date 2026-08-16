import { ApiException } from '../common/errors/api.exception';
import {
  ContactNotFoundError,
  ContactPhoneTakenError,
  CustomFieldInUseByRulesError,
  CustomFieldKeyTakenError,
  CustomFieldNotFoundError,
  CustomFieldOptionsMismatchError,
  CustomFieldSetChangedError,
  CustomFieldValuesInvalidError,
  TooManyCustomFieldsError,
} from './contacts.errors';
import { translateTagFailure } from '../tags/tags.http';

/**
 * The one place a contact- or custom-field-domain failure becomes an HTTP
 * answer, on `people.http.ts`' pattern and for the same reason: written once, so
 * the same condition cannot answer 409 on one route and 400 on another.
 *
 * Two choices worth stating, because they are where information leaks:
 *
 *   * **A record the caller may not see is `not_found`, never `forbidden`.**
 *     Another tenant's contact is already invisible — RLS returns nothing and
 *     the service raises `ContactNotFoundError` — and a 403 there would confirm
 *     the id exists somewhere.
 *   * **A bad *reference* is `validation_failed` naming the field, not
 *     `not_found`.** The missing thing is not the resource being addressed, and
 *     RLS means the server genuinely cannot tell another tenant's tag from a tag
 *     that never existed.
 *
 * Tag failures are delegated rather than re-mapped: `PATCH /contacts/{id}`
 * carries `tagIds`, and the answer to an unknown tag must be the same one
 * `POST /tags` would give.
 *
 * Anything unrecognised is rethrown untouched — including
 * `UnsupportedCustomFieldTypeError`, which is a fault about stored data rather
 * than about the request. Reporting a database outage as a validation error
 * would hide it.
 */
export function translateContactFailure(error: unknown): never {
  if (error instanceof ContactNotFoundError || error instanceof CustomFieldNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof CustomFieldValuesInvalidError) {
    throw new ApiException('validation_failed', error.message, error.issues);
  }

  if (error instanceof CustomFieldOptionsMismatchError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'options', message: error.message },
    ]);
  }

  if (error instanceof CustomFieldInUseByRulesError) {
    throw new ApiException(
      'conflict',
      error.message,
      error.rules.map((rule) => ({ path: 'assignmentRuleId', message: rule.id })),
    );
  }

  if (
    error instanceof ContactPhoneTakenError ||
    error instanceof CustomFieldKeyTakenError ||
    error instanceof TooManyCustomFieldsError ||
    error instanceof CustomFieldSetChangedError
  ) {
    throw new ApiException('conflict', error.message);
  }

  return translateTagFailure(error);
}
