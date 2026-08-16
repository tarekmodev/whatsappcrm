import {
  customFieldValueIssue,
  type CustomFieldDefinition,
  type CustomFieldValues,
} from '@whatsappcrm/contracts';

/**
 * The contact profile's custom-field form, as pure functions over a draft.
 *
 * Kept out of the component because all three of the rules here are easy to get
 * wrong once and impossible to notice afterwards:
 *
 *   1. **A write is a merge** (0002 amendment 10). Only the keys the agent
 *      actually changed are sent; an empty box is an explicit `null` that clears
 *      one, and a key the form never showed is left alone. Sending the whole map
 *      back would make two agents editing different fields a last-writer-wins
 *      data loss.
 *   2. **Only a changed value is validated.** Removing an option from a `select`
 *      leaves the contacts holding it untouched until that field is next
 *      written, so a stale value must not block a save of some *other* field.
 *   3. **Validation is the contract's**, through `customFieldValueIssue` — the
 *      single copy of "is this legal", so the console disables a save the API
 *      would refuse rather than keeping a second table of rules in step.
 */

/** Every defined key, as the string its control holds. `''` means "not set". */
export type CustomFieldDraft = Readonly<Record<string, string>>;

/**
 * Trimmed, because `''` and `'   '` mean the same thing to every control here
 * and only one of them is a value the API would accept. `Number(' 1 ')` is 1, so
 * an untrimmed draft would pass validation and store padding nobody typed.
 */
function normalise(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * The form's starting state: one entry per *definition*, so a key the contact has
 * never been given renders as an empty control rather than being absent, and a
 * stored key with no definition behind it is not offered for editing at all.
 */
export function customFieldDraft(
  definitions: readonly CustomFieldDefinition[],
  values: CustomFieldValues,
): CustomFieldDraft {
  return Object.fromEntries(
    definitions.map((definition) => [definition.key, normalise(values[definition.key] ?? '')]),
  );
}

/** The keys whose control no longer holds what it started with. */
export function changedCustomFieldKeys(
  definitions: readonly CustomFieldDefinition[],
  initial: CustomFieldDraft,
  draft: CustomFieldDraft,
): readonly string[] {
  return definitions
    .map((definition) => definition.key)
    .filter((key) => normalise(draft[key]) !== normalise(initial[key]));
}

/**
 * Per-key validation messages, keyed by field `key`. Empty when the draft is
 * saveable.
 *
 * Only changed keys are checked, and a cleared one always passes: `null` is legal
 * for every type.
 */
export function customFieldIssues(
  definitions: readonly CustomFieldDefinition[],
  initial: CustomFieldDraft,
  draft: CustomFieldDraft,
): Readonly<Record<string, string>> {
  const changed = new Set(changedCustomFieldKeys(definitions, initial, draft));
  const issues: Record<string, string> = {};

  for (const definition of definitions) {
    if (!changed.has(definition.key)) {
      continue;
    }

    const value = normalise(draft[definition.key]);

    if (value === '') {
      continue;
    }

    const issue = customFieldValueIssue(definition, value);

    if (issue !== null) {
      issues[definition.key] = issue;
    }
  }

  return issues;
}

/**
 * The merge patch to send, or `null` when nothing changed — which is what lets
 * the card refuse to submit rather than sending an empty write the API would
 * answer `validation_failed` for.
 */
export function customFieldPatch(
  definitions: readonly CustomFieldDefinition[],
  initial: CustomFieldDraft,
  draft: CustomFieldDraft,
): CustomFieldValues | null {
  const changed = changedCustomFieldKeys(definitions, initial, draft);

  if (changed.length === 0) {
    return null;
  }

  return Object.fromEntries(
    changed.map((key) => {
      const value = normalise(draft[key]);

      // An emptied control is an explicit `null`. Omitting it would mean "leave
      // it as it was", and the agent's clear would silently do nothing.
      return [key, value === '' ? null : value];
    }),
  );
}

/**
 * The tag ids to send, or `null` when the selection is unchanged.
 *
 * Order is not meaningful for a tag set, so the comparison is set-wise — a list
 * the API returned in a different order is not an edit.
 */
export function contactTagPatch(
  initialTagIds: readonly string[],
  draftTagIds: readonly string[],
): readonly string[] | null {
  if (initialTagIds.length === draftTagIds.length) {
    const initial = new Set(initialTagIds);

    if (draftTagIds.every((id) => initial.has(id))) {
      return null;
    }
  }

  return [...draftTagIds];
}
