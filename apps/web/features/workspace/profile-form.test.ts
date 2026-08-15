import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { validateProfile, WORKSPACE_NAME_MAX_LENGTH } from './profile-form';

/**
 * The client-side half of the profile form's validation. The point of these is
 * that the rules come from the contract's own schemas, so the cases that matter
 * are the boundaries — one over the name limit, and an empty support address,
 * which is valid rather than missing.
 */

const VALID = { name: 'Northwind Traders', supportEmail: 'support@northwind.example' };

describe('workspace profile validation', () => {
  it('accepts a filled-in profile', () => {
    expect(validateProfile(VALID)).toEqual({});
  });

  it('requires a name, and does not accept whitespace as one', () => {
    expect(validateProfile({ ...VALID, name: '' }).name).toBe(content.workspace.nameRequiredError);
    expect(validateProfile({ ...VALID, name: '   ' }).name).toBe(
      content.workspace.nameRequiredError,
    );
  });

  it('refuses a name one character over the contract’s limit', () => {
    expect(WORKSPACE_NAME_MAX_LENGTH).toBeTypeOf('number');

    const max = WORKSPACE_NAME_MAX_LENGTH ?? 0;

    expect(validateProfile({ ...VALID, name: 'a'.repeat(max) })).toEqual({});
    expect(validateProfile({ ...VALID, name: 'a'.repeat(max + 1) }).name).toBe(
      content.workspace.nameTooLongError(max),
    );
  });

  /**
   * An emptied support address is a cleared field, not a missing one — the
   * contract's `supportEmail` is nullable. Flagging it would leave a workspace
   * that has no support alias unable to save anything else.
   */
  it('accepts an empty support address', () => {
    expect(validateProfile({ ...VALID, supportEmail: '' })).toEqual({});
    expect(validateProfile({ ...VALID, supportEmail: '  ' })).toEqual({});
  });

  it('refuses a support address that is not one', () => {
    expect(validateProfile({ ...VALID, supportEmail: 'not-an-address' }).supportEmail).toBe(
      content.form.invalidEmailError,
    );
  });

  it('reports both fields at once, so a submit is not a game of whack-a-mole', () => {
    expect(validateProfile({ name: '', supportEmail: 'nope' })).toEqual({
      name: content.workspace.nameRequiredError,
      supportEmail: content.form.invalidEmailError,
    });
  });
});
