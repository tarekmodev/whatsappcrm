import {
  customFieldValueIssue,
  type ApiErrorDetail,
  type CustomFieldDefinition,
  type CustomFieldValues,
} from '@whatsappcrm/contracts';
import { CustomFieldValuesInvalidError } from './contacts.errors';

/**
 * The write half of `ContactResponse.customFields` (0002 amendment 10).
 *
 * Two rules, both of which the amendment names as decisions rather than details:
 *
 *   * **A write is a merge, not a replacement.** Keys present are set, an
 *     explicit `null` clears one, and keys absent are left exactly as they were.
 *     Replacement would make an agent who edits a phone number silently erase
 *     every custom value their form did not happen to load.
 *
 *     The merge is **not** what makes two agents editing different fields on the
 *     same contact safe, and reading it that way is how the concurrent case gets
 *     missed. This is a pure function over a map its caller has already read: two
 *     callers that read the same stored map both merge into that same map, and
 *     the second write replaces the first whole. What actually holds there is the
 *     row lock `ContactsService.update` takes before its read (`lockContact`,
 *     `SELECT … FOR NO KEY UPDATE`) — the merge stops an *unloaded* key being
 *     erased, the lock stops a *concurrently written* one being erased.
 *   * **An unknown key is refused, never silently dropped.** A typo that stores
 *     nothing and reports success is the same silent-failure shape the amendment
 *     refuses on the definition side.
 *
 * Validation is the contract's own `customFieldValueIssue` rather than a second
 * copy of the rules here, so the console can disable a save the API would refuse
 * and the two can never drift.
 *
 * **Only the keys the write carries are validated**, which is what makes
 * removing an option from a `select` safe: a contact holding the removed value
 * keeps it until that field is next written, and a save of some *other* field is
 * not blocked by it.
 */

/** `details[].path` for a rejected value, as amendment 10 publishes it. */
function pathFor(key: string): string {
  return `customFields.${key}`;
}

/**
 * The stored map with `incoming` merged into it, or a
 * `CustomFieldValuesInvalidError` naming every offending key.
 *
 * Every issue is collected before throwing rather than failing on the first, so
 * an agent fixing a form is told about all of it at once.
 */
export function mergeCustomFieldValues(
  stored: CustomFieldValues,
  incoming: CustomFieldValues,
  definitions: readonly CustomFieldDefinition[],
): CustomFieldValues {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const issues: ApiErrorDetail[] = [];
  const merged: CustomFieldValues = { ...stored };

  for (const [key, value] of Object.entries(incoming)) {
    const definition = byKey.get(key);

    if (definition === undefined) {
      issues.push({ path: pathFor(key), message: 'No custom field with this key is defined.' });
      continue;
    }

    const issue = customFieldValueIssue(definition, value);

    if (issue !== null) {
      issues.push({ path: pathFor(key), message: issue });
      continue;
    }

    // `null` clears rather than storing a null: the contract says a key the
    // contact has never been given is *absent* from a response, so storing one
    // would publish a distinction the schema says does not exist.
    if (value === null) {
      delete merged[key];
      continue;
    }

    merged[key] = value;
  }

  if (issues.length > 0) {
    throw new CustomFieldValuesInvalidError(issues);
  }

  return merged;
}
