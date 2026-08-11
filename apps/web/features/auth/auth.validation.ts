import {
  AUTH_POLICY,
  InviteAcceptInputSchema,
  LoginInputSchema,
  PasswordSchema,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * Field-level validation for the auth screens, checked against the *contract's*
 * own schemas — the identical objects the API validates with, so the console can
 * never accept something the API will reject, or reject something it would have
 * taken.
 *
 * Each function answers a message or `null`, which is exactly what `Field`'s
 * `error` prop takes. Nothing here throws: a form that throws loses the input the
 * user just typed.
 */

export function validateEmail(value: string): string | null {
  if (value.length === 0) {
    return content.form.requiredFieldError;
  }

  return LoginInputSchema.shape.email.safeParse(value).success
    ? null
    : content.form.invalidEmailError;
}

/** Sign-in only asserts that something was typed; the API decides the rest. */
export function validateRequired(value: string): string | null {
  return value.length === 0 ? content.form.requiredFieldError : null;
}

export function validateNewPassword(value: string): string | null {
  if (value.length === 0) {
    return content.form.requiredFieldError;
  }

  if (PasswordSchema.safeParse(value).success) {
    return null;
  }

  // The cap is not cosmetic — an unbounded password is an unbounded amount of
  // argon2id hashing an unauthenticated caller can ask for — so it gets its own
  // message rather than being reported as "too short".
  return value.length > AUTH_POLICY.passwordMaxLength
    ? content.auth.passwordTooLongError(AUTH_POLICY.passwordMaxLength)
    : content.auth.passwordTooShortError(AUTH_POLICY.passwordMinLength);
}

export function validateDisplayName(value: string): string | null {
  if (value.length === 0) {
    return content.form.requiredFieldError;
  }

  return InviteAcceptInputSchema.shape.displayName.safeParse(value).success
    ? null
    : content.auth.inviteDisplayNameTooLongError;
}
