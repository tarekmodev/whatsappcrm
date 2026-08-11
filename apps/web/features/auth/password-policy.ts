import { AUTH_POLICY, PasswordSchema } from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * Client-side validation for a new password, shared by the reset screen and the
 * change screen.
 *
 * The rule itself is the contract's `PasswordSchema` — the identical object the
 * API validates with — so the two cannot disagree and nobody is sent on a round
 * trip to be told their password is eleven characters long. The bounds are read
 * from `AUTH_POLICY` for the message text rather than restated, for the same
 * reason.
 *
 * The confirmation field is purely a client-side guard: the contract has no such
 * field, because the API has no way to know whether two identical strings were
 * typed twice on purpose.
 */

export interface NewPasswordErrors {
  password?: string;
  confirmation?: string;
}

export function validateNewPassword(password: string, confirmation: string): NewPasswordErrors {
  const passwordError = newPasswordError(password);

  if (passwordError !== undefined) {
    // No point telling somebody their confirmation does not match a password
    // they are about to have to change anyway.
    return { password: passwordError };
  }

  return confirmation === password
    ? {}
    : { confirmation: content.auth.passwordMismatchError };
}

export function hasErrors(errors: NewPasswordErrors): boolean {
  return errors.password !== undefined || errors.confirmation !== undefined;
}

function newPasswordError(password: string): string | undefined {
  if (password.length === 0) {
    return content.auth.passwordRequiredError;
  }

  if (PasswordSchema.safeParse(password).success) {
    return undefined;
  }

  return password.length < AUTH_POLICY.passwordMinLength
    ? content.auth.passwordTooShortError(AUTH_POLICY.passwordMinLength)
    : content.auth.passwordTooLongError(AUTH_POLICY.passwordMaxLength);
}
