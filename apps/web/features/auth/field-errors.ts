import { InviteAcceptInputSchema, LoginInputSchema } from '@whatsappcrm/contracts';
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
