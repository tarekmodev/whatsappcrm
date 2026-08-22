import {
  CANNED_RESPONSE_LIMITS,
  CANNED_RESPONSE_TRIGGER,
  CannedResponseShortcutSchema,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * The saved-reply form, as pure functions over a draft.
 *
 * Kept out of the dialogs because the create and edit dialogs need the same
 * answers, and the rules are the contract's rather than the form's: what a legal
 * shortcut looks like, and how long each field may be. Validating against
 * `CannedResponseShortcutSchema` here means the dialog refuses what the API
 * would refuse, without a second copy of the grammar to keep in step.
 */

export interface CannedResponseDraft {
  readonly shortcut: string;
  readonly title: string;
  readonly body: string;
}

/** Per-field messages, keyed by draft field. Empty when the draft is saveable. */
export type CannedResponseIssues = Partial<Record<'shortcut' | 'title' | 'body', string>>;

/**
 * The shortcut as the API stores it: trimmed, lowercased, and carrying its
 * leading trigger.
 *
 * Both corrections exist because the alternative is a refusal nobody can learn
 * from. `shortcut` is `citext`, so `/Hours` and `/hours` are the same row — a
 * form that reported "use lowercase" would be enforcing a distinction the
 * database does not make. And an admin who types `hours` in a box labelled
 * Shortcut has said exactly what they meant; answering that with "must start
 * with `/`" is punctuation pedantry the field can just apply.
 *
 * Applied on blur and again on submit, never on the keystroke: rewriting the
 * value under a cursor mid-word is how a text field starts eating characters.
 */
export function normaliseShortcut(raw: string): string {
  const trimmed = raw.trim().toLowerCase();

  if (trimmed.length === 0) {
    return '';
  }

  return trimmed.startsWith(CANNED_RESPONSE_TRIGGER)
    ? trimmed
    : `${CANNED_RESPONSE_TRIGGER}${trimmed}`;
}

/**
 * Validates a normalised draft. Callers normalise first — `cannedResponseIssues`
 * does not do it for them, because the value it judges has to be the value the
 * admin can see in the box.
 */
export function cannedResponseIssues(draft: CannedResponseDraft): CannedResponseIssues {
  const issues: CannedResponseIssues = {};
  const shortcut = draft.shortcut;
  const title = draft.title.trim();
  const body = draft.body.trim();

  if (shortcut.length === 0) {
    issues.shortcut = content.form.requiredFieldError;
  } else if (shortcut.length > CANNED_RESPONSE_LIMITS.shortcutLength) {
    // Length and grammar are reported separately, as the contract checks them
    // separately: "too long" and "malformed" need different fixes, and a single
    // bounded regular expression could only ever say one of them.
    issues.shortcut = content.cannedResponses.shortcutTooLongError(
      CANNED_RESPONSE_LIMITS.shortcutLength,
    );
  } else if (!CannedResponseShortcutSchema.safeParse(shortcut).success) {
    issues.shortcut = content.cannedResponses.shortcutInvalidError(CANNED_RESPONSE_TRIGGER);
  }

  if (title.length === 0) {
    issues.title = content.form.requiredFieldError;
  }

  if (body.length === 0) {
    issues.body = content.form.requiredFieldError;
  }

  // No over-length check for the title or the body: both controls carry the
  // contract's `maxLength`, so the keystroke is what stops them, and a message
  // under a box that cannot hold a longer value would never be read.

  return issues;
}

export function hasIssues(issues: CannedResponseIssues): boolean {
  return Object.keys(issues).length > 0;
}

/**
 * Drops one field's message, for the moment its control is edited — a stale
 * error under a value the admin has already fixed reads as a form that is stuck.
 *
 * Returns the same object when there was nothing to clear, so an edit to a field
 * with no error does not re-render every other one.
 */
export function clearIssue(
  issues: CannedResponseIssues,
  field: keyof CannedResponseIssues,
): CannedResponseIssues {
  if (issues[field] === undefined) {
    return issues;
  }

  const next = { ...issues };

  delete next[field];

  return next;
}
