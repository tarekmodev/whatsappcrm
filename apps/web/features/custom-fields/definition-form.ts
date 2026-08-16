import {
  CUSTOM_FIELD_LIMITS,
  CustomFieldKeySchema,
  RESERVED_CUSTOM_FIELD_KEYS,
  type CustomFieldType,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * The custom-field definition form, as pure functions over a draft.
 *
 * Kept out of the dialogs because both of them need the same answers and the
 * rules are the contract's, not the form's: what a legal key looks like, when
 * `options` is required, and how a textarea of lines becomes the array the API
 * takes. Validating here means the dialog disables a save the API would refuse
 * rather than keeping a second copy of the rules in step.
 */

export interface DefinitionDraft {
  readonly label: string;
  readonly key: string;
  readonly type: CustomFieldType;
  /** Raw textarea contents; one option per line. */
  readonly optionsText: string;
}

/** Per-field messages, keyed by draft field. Empty when the draft is saveable. */
export type DefinitionIssues = Partial<Record<'label' | 'key' | 'options', string>>;

/**
 * A textarea of lines as the array the contract takes.
 *
 * Blank lines are dropped rather than sent as empty options, because a trailing
 * newline is what a textarea gives you for free and refusing the form over it
 * would be a validation error nobody typed.
 */
export function parseOptionsText(optionsText: string): string[] {
  return optionsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Suggests `plan_tier` from "Plan tier", so an admin rarely types the key at all.
 *
 * The suggestion is always one `CustomFieldKeySchema` accepts, or empty. That
 * matters because the box is filled in *for* the admin: a label of "2FA enabled"
 * suggesting `2fa_enabled` and then reporting `keyInvalidError` would be the form
 * refusing a value nobody typed. `^[a-z]` is the rule, so a leading run of
 * digits or underscores is dropped rather than offered.
 *
 * An empty result — "2024", say — leaves the box untouched for the admin to fill
 * in, which is the honest answer when there is no legal key to derive.
 */
export function suggestKeyFromLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      // Leading non-letters, not just underscores: the schema requires the first
      // character to be `a`–`z`.
      .replace(/^[^a-z]+/, '')
      .replace(/_+$/, '')
      .slice(0, CUSTOM_FIELD_LIMITS.keyLength)
      // The slice can re-expose a trailing underscore that was mid-string before.
      .replace(/_+$/, '')
  );
}

/**
 * Validates the whole draft. `isKeyEditable` is false when editing an existing
 * definition — `key` and `type` are immutable after creation, so an edit has
 * nothing to say about either and reporting a problem with a field the dialog
 * does not offer would be unactionable.
 */
export function definitionIssues(
  draft: DefinitionDraft,
  { isKeyEditable }: { isKeyEditable: boolean },
): DefinitionIssues {
  const issues: DefinitionIssues = {};
  const label = draft.label.trim();

  if (label.length === 0) {
    issues.label = content.form.requiredFieldError;
  }

  if (isKeyEditable) {
    const key = draft.key.trim();

    if (key.length === 0) {
      issues.key = content.form.requiredFieldError;
    } else if (RESERVED_CUSTOM_FIELD_KEYS.some((reserved) => reserved === key)) {
      // Reported separately from the shape failure below: "that key is taken by a
      // built-in field" and "keys look like this" need different fixes.
      issues.key = content.customFields.keyReservedError;
    } else if (!CustomFieldKeySchema.safeParse(key).success) {
      issues.key = content.customFields.keyInvalidError;
    }
  }

  const optionsIssue = optionsIssueFor(draft);

  if (optionsIssue !== undefined) {
    issues.options = optionsIssue;
  }

  return issues;
}

/**
 * `options` is required for `select` and forbidden otherwise, in both directions
 * — the contract's own `optionsMatchType` refinement. A non-`select` draft can
 * only fail it by carrying options, which this form makes impossible: the
 * textarea is not rendered for the other four types.
 */
function optionsIssueFor(draft: DefinitionDraft): string | undefined {
  if (draft.type !== 'select') {
    return undefined;
  }

  const options = parseOptionsText(draft.optionsText);

  if (options.length === 0) {
    return content.customFields.optionsRequiredError;
  }

  if (options.length > CUSTOM_FIELD_LIMITS.optionsPerDefinition) {
    return content.customFields.optionsTooManyError(CUSTOM_FIELD_LIMITS.optionsPerDefinition);
  }

  if (options.some((option) => option.length > CUSTOM_FIELD_LIMITS.optionLength)) {
    return content.customFields.optionsTooLongError(CUSTOM_FIELD_LIMITS.optionLength);
  }

  if (new Set(options).size !== options.length) {
    return content.customFields.optionsDuplicateError;
  }

  return undefined;
}

export function hasIssues(issues: DefinitionIssues): boolean {
  return Object.keys(issues).length > 0;
}

/**
 * Drops one field's message, for the moment its control is edited — a stale
 * error under a value the user has already fixed reads as a form that is stuck.
 *
 * Returns the same object when there was nothing to clear, so an edit to a field
 * with no error does not re-render every other one.
 */
export function clearIssue(
  issues: DefinitionIssues,
  field: keyof DefinitionIssues,
): DefinitionIssues {
  if (issues[field] === undefined) {
    return issues;
  }

  const next = { ...issues };

  delete next[field];

  return next;
}

/** The array back as textarea contents, for the edit dialog's starting state. */
export function optionsToText(options: readonly string[]): string {
  return options.join('\n');
}
