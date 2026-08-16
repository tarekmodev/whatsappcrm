import { TenantBrandingSchema, TenantNameSchema } from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * Client-side validation for the workspace profile form.
 *
 * The rules are the contract's own schemas — the identical objects the API
 * validates with — so the two cannot disagree and nobody is sent on a round trip
 * to be told their name is 121 characters long. Same shape as
 * `features/auth/password-policy.ts`, for the same reason.
 *
 * This is convenience, never enforcement: the server action re-parses the body
 * against `TenantUpdateInputSchema` and the API refuses it again behind that.
 */

export interface ProfileInput {
  readonly name: string;
  /** Empty means "there is no support address", which the contract spells `null`. */
  readonly supportEmail: string;
}

export interface ProfileErrors {
  name?: string;
  supportEmail?: string;
}

/**
 * Read from the schema rather than restated, so the control's `maxLength` and
 * the rule that refuses the value cannot drift. `TenantNameSchema` declares a
 * `.max()`, so this is never null in practice; the fallback exists because the
 * accessor's type says it could be.
 */
export const WORKSPACE_NAME_MAX_LENGTH = TenantNameSchema.maxLength ?? undefined;

export function validateProfile(input: ProfileInput): ProfileErrors {
  const errors: ProfileErrors = {};
  const name = input.name.trim();
  const supportEmail = input.supportEmail.trim();

  if (name.length === 0) {
    errors.name = content.workspace.nameRequiredError;
  } else if (!TenantNameSchema.safeParse(name).success) {
    errors.name =
      WORKSPACE_NAME_MAX_LENGTH === undefined
        ? content.form.genericSubmitError
        : content.workspace.nameTooLongError(WORKSPACE_NAME_MAX_LENGTH);
  }

  // An empty address is valid — the contract's `supportEmail` is nullable — so
  // only a non-empty one is checked. Validating the whole branding object would
  // demand the colours this form does not carry, hence the single field.
  if (
    supportEmail !== '' &&
    !TenantBrandingSchema.shape.supportEmail.safeParse(supportEmail).success
  ) {
    errors.supportEmail = content.form.invalidEmailError;
  }

  return errors;
}
