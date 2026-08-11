import { screen } from '@testing-library/react';

/**
 * Finds a control by the label text a `Field` was given. Usage:
 * `fireEvent.change(fieldByLabel('New password'), { target: { value: … } })`.
 *
 * Test-only, imported by nothing in the app. It exists because `Field` appends a
 * decorative ` *` to a required label, so an exact-match query has to know that
 * and a substring query is worse — "New password" would also match "Confirm new
 * password", and silently assert against the wrong control.
 *
 * Anchored regex: the label, optionally followed by the required marker, and
 * nothing else.
 */
export function fieldByLabel(label: string): HTMLElement {
  return screen.getByLabelText(new RegExp(`^${escapeRegExp(label)}(\\s*\\*)?$`));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
