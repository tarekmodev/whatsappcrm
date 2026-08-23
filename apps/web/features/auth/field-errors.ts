import {
  InviteAcceptInputSchema,
  LoginInputSchema,
  SignupInputSchema,
  TenantSlugSchema,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * The non-password field checks the signed-out screens share, run against the
 * *contract's* own schemas — the identical objects the API validates with, so the
 * console can never accept something the API will reject, or reject something it
 * would have taken.
 *
 * Passwords are `password-policy.ts`; the split is that a password has a policy
 * worth stating to the user, and these have a shape.
 *
 * Each returns a message or `undefined`, which is what `Field`'s `error` prop
 * takes. Nothing here throws: a form that throws loses the input just typed.
 */

export function emailFieldError(value: string): string | undefined {
  if (value.length === 0) {
    return content.form.requiredFieldError;
  }

  return LoginInputSchema.shape.email.safeParse(value).success
    ? undefined
    : content.form.invalidEmailError;
}

export function displayNameFieldError(value: string): string | undefined {
  if (value.length === 0) {
    return content.auth.inviteDisplayNameRequiredError;
  }

  return InviteAcceptInputSchema.shape.displayName.safeParse(value).success
    ? undefined
    : content.auth.inviteDisplayNameTooLongError;
}

/** The signup form's "Your name" — the first administrator's display name. */
export function adminNameFieldError(value: string): string | undefined {
  if (value.length === 0) {
    return content.auth.signupNameRequiredError;
  }

  return SignupInputSchema.shape.adminName.safeParse(value).success
    ? undefined
    : content.auth.signupNameTooLongError;
}

export function workspaceNameFieldError(value: string): string | undefined {
  if (value.length === 0) {
    return content.auth.signupWorkspaceNameRequiredError;
  }

  return SignupInputSchema.shape.tenantName.safeParse(value).success
    ? undefined
    : content.auth.signupWorkspaceNameTooLongError;
}

/**
 * The workspace address, which is the one field here with three distinct ways to
 * be wrong — and they are worth separating, because "too short" and "that
 * character is not allowed" are fixed by different edits.
 *
 * What it does **not** answer is whether the address is *taken*: that is a
 * question only the API can answer, and `useSlugAvailability` asks it. This is
 * the shape check that runs first, and the thing that keeps a check from being
 * spent on a value the API would refuse with `validation_failed` anyway.
 */
export function slugFieldError(value: string): string | undefined {
  if (value.length === 0) {
    return content.auth.signupSlugRequiredError;
  }

  if (value.length < SLUG_MIN_LENGTH) {
    return content.auth.signupSlugTooShortError(SLUG_MIN_LENGTH);
  }

  if (value.length > SLUG_MAX_LENGTH) {
    return content.auth.signupSlugTooLongError(SLUG_MAX_LENGTH);
  }

  return TenantSlugSchema.safeParse(value).success
    ? undefined
    : content.auth.signupSlugInvalidError;
}

/**
 * The bounds, read off the contract's own schema rather than restated — the rule
 * this whole module exists for.
 *
 * It throws rather than falling back to a literal if the schema ever stops
 * publishing them. A default here would be a second copy of the policy that
 * looks right until the day it silently disagrees with the API, which is exactly
 * the failure this file was written to prevent; failing at module load puts it in
 * front of whoever made the change, and `field-errors.test.ts` reaches it first.
 */
function slugBound(bound: number | null, name: string): number {
  if (bound === null) {
    throw new Error(
      `TenantSlugSchema no longer publishes its ${name}; the signup form reads it from the contract.`,
    );
  }

  return bound;
}

const SLUG_MIN_LENGTH = slugBound(TenantSlugSchema.minLength, 'minimum length');
const SLUG_MAX_LENGTH = slugBound(TenantSlugSchema.maxLength, 'maximum length');
