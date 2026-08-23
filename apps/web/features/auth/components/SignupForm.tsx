'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IanaTimezoneSchema, type SignupAcceptedResponse } from '@whatsappcrm/contracts';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthCard } from './AuthCard';
import { AuthForm } from './AuthForm';
import { AuthOutcomeCard } from './AuthOutcomeCard';
import { PasswordField } from './PasswordField';
import { SignupSentCard } from './SignupSentCard';
import { SignupSlugField } from './SignupSlugField';
import { createWorkspace, type SignupOutcome } from '../signup.requests';
import {
  adminNameFieldError,
  emailFieldError,
  slugFieldError,
  workspaceNameFieldError,
} from '../field-errors';
import { hasErrors, validateNewPassword, type NewPasswordErrors } from '../password-policy';
import { useSlugAvailability } from '../useSlugAvailability';

/**
 * Create a workspace. Usage: `<SignupForm platformHost={host} />`.
 *
 * The one screen on the signed-out surface that is not about an account which
 * already exists, and the only one a visitor can reach with **no session and no
 * tenant** — which is what makes every other auth screen's assumptions
 * unavailable here.
 *
 * ## What it collects, and why the password is on this form
 *
 * All of it, including the password, because `SignupInputSchema` takes it here:
 * a verification page that asks for a password is a page an attacker who
 * intercepted the emailed link can *complete*, whereas one that only confirms is
 * not. The value is argon2-hashed before the pending row is written and the row
 * is swept if the link lapses, so an abandoned signup leaves no credential
 * behind.
 *
 * ## Three answers that are screen states rather than form errors
 *
 * `SignupOutcome` carries them through the success channel, on the rule the
 * invite screen already follows — see `signup.requests.ts`. `slug_taken` is the
 * exception that stays on the form, because it is the one refusal an edit to a
 * single field fixes.
 *
 * ## The order of the fields
 *
 * The workspace first, then the person. It is what the title says is being
 * created, the address is the field that needs the most thought, and asking for
 * it while somebody still has the energy to choose one is better than asking
 * after four other fields have already been filled in.
 */
export function SignupForm({ platformHost }: { platformHost: string }) {
  const content = useContent();
  const slugInputRef = useRef<HTMLInputElement>(null);
  /** Set when a submit comes back refusing the address; spent by the effect below. */
  const shouldFocusSlugRef = useRef(false);

  const [workspaceName, setWorkspaceName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminName, setAdminName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
  const [passwordErrors, setPasswordErrors] = useState<NewPasswordErrors>({});
  /**
   * The conflict the *submit* came back with, kept apart from the shape errors
   * above so that editing any other field does not clear the one refusal that is
   * still true.
   */
  const [conflictedSlug, setConflictedSlug] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<SignupAcceptedResponse | null>(null);
  const [isSignupDisabled, setIsSignupDisabled] = useState(false);

  /*
   * `null` while the value is not worth a round trip — empty, or a shape the API
   * would refuse with `validation_failed` anyway. That check is free and the one
   * below it is rate-limited, so the free one goes first.
   */
  const availability = useSlugAvailability(slugFieldError(slug) === undefined ? slug : null);
  const isKnownTaken = availability.status === 'settled' && availability.availability === 'taken';

  const perform = useCallback(async () => {
    const timezone = resolveBrowserTimezone();

    return createWorkspace({
      email: email.trim(),
      password,
      adminName: adminName.trim(),
      tenantName: workspaceName.trim(),
      // Not trimmed: `slugFieldError` has already refused anything with a space
      // in it, so a trim here could only ever hide a value the user can see.
      slug,
      // Omitted rather than defaulted when the browser will not name a zone —
      // `TenantProvisioningService` has a default and this form does not.
      ...(timezone === null ? {} : { timezone }),
    });
  }, [adminName, email, password, slug, workspaceName]);

  const onSuccess = useCallback(
    (outcome: SignupOutcome) => {
      if (outcome.kind === 'accepted') {
        setAccepted(outcome.accepted);
        return;
      }

      if (outcome.kind === 'disabled') {
        setIsSignupDisabled(true);
        return;
      }

      /*
       * Somebody took the address between the availability check and this
       * submit — a real race, because a pending signup holds a soft reservation
       * the moment it is written.
       *
       * Focus belongs on the field rather than on the button it was pressed
       * from: `AuthForm` only chases an invalid control on the render a submit
       * *attempt* produces, and this refusal arrives a round trip later than
       * that. It cannot be moved from here, though — see below.
       */
      setConflictedSlug(slug);
      shouldFocusSlugRef.current = true;
    },
    [slug],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  /*
   * The focus, deferred until the form is editable again.
   *
   * `onSuccess` runs while the request is still in flight — `useActionForm`
   * clears `isPending` in its `finally`, after the handler — and `AuthForm`
   * disables the whole fieldset for exactly that window. Focusing a control
   * inside a disabled fieldset does nothing at all, silently, so calling it
   * there would leave the user on the submit button with a red field they have
   * no reason to look at.
   */
  useEffect(() => {
    if (isPending || !shouldFocusSlugRef.current) {
      return;
    }

    shouldFocusSlugRef.current = false;
    slugInputRef.current?.focus();
  }, [isPending]);

  if (isSignupDisabled) {
    return (
      <AuthOutcomeCard
        icon="warning"
        tone="danger"
        title={content.auth.signupDisabledHeading}
        body={content.auth.signupDisabledBody}
        action={
          <ButtonLink href={routes.login()} variant="primary" isBlock>
            {content.auth.backToSignIn}
          </ButtonLink>
        }
      />
    );
  }

  if (accepted !== null) {
    return (
      <SignupSentCard
        accepted={accepted}
        onUseAnotherAddress={() => {
          // Back to the form with everything still in it: the usual reason to be
          // here is a typo in one field, and retyping five others to fix one
          // character is the wrong ask.
          setAccepted(null);
        }}
      />
    );
  }

  const slugError =
    fieldErrors.slug ??
    (conflictedSlug === slug || isKnownTaken ? content.auth.signupSlugTakenError : undefined);

  return (
    <AuthCard title={content.auth.signupTitle} description={content.auth.signupDescription}>
      <AuthForm
        submitLabel={content.auth.signupSubmit}
        pendingLabel={content.auth.signupPending}
        isPending={isPending}
        formError={formError}
        requestId={requestId}
        footer={
          <span>
            {content.auth.signupSignInPrompt}{' '}
            <TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>
          </span>
        }
        onSubmit={() => {
          const nextFieldErrors: SignupFieldErrors = {
            workspaceName: workspaceNameFieldError(workspaceName.trim()),
            slug: slugFieldError(slug),
            adminName: adminNameFieldError(adminName.trim()),
            email: emailFieldError(email.trim()),
          };
          const nextPasswordErrors = validateNewPassword(password, confirmation);

          setFieldErrors(nextFieldErrors);
          setPasswordErrors(nextPasswordErrors);

          const isShapeValid = Object.values(nextFieldErrors).every(
            (message) => message === undefined,
          );

          /*
           * A *known* refusal blocks the submit; an unfinished or failed check
           * does not. The availability endpoint is a courtesy — `POST /signup`
           * is what actually decides — so a customer whose check is still in
           * flight, or whose check could not run at all, still gets to press the
           * button.
           */
          if (isShapeValid && !hasErrors(nextPasswordErrors) && !isKnownTaken) {
            submit();
          }
        }}
      >
        <Field
          label={content.auth.signupWorkspaceNameLabel}
          hint={content.auth.signupWorkspaceNameHint}
          error={fieldErrors.workspaceName}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              autoComplete="organization"
              name="tenantName"
              value={workspaceName}
              onChange={(event) => {
                setWorkspaceName(event.target.value);
                setFieldErrors((current) => ({ ...current, workspaceName: undefined }));
              }}
            />
          )}
        </Field>

        <SignupSlugField
          inputRef={slugInputRef}
          value={slug}
          platformHost={platformHost}
          error={slugError}
          availability={availability}
          onChange={(value) => {
            setSlug(value);
            setFieldErrors((current) => ({ ...current, slug: undefined }));
          }}
        />

        <Field
          label={content.auth.signupNameLabel}
          hint={content.auth.signupNameHint}
          error={fieldErrors.adminName}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              autoComplete="name"
              name="adminName"
              value={adminName}
              onChange={(event) => {
                setAdminName(event.target.value);
                setFieldErrors((current) => ({ ...current, adminName: undefined }));
              }}
            />
          )}
        </Field>

        <Field label={content.auth.emailLabel} error={fieldErrors.email} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              type="email"
              inputMode="email"
              // `username`, as the sign-in form uses, so a password manager files
              // this and the password below as one credential for one site.
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              name="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((current) => ({ ...current, email: undefined }));
              }}
            />
          )}
        </Field>

        <PasswordField
          label={content.auth.signupPasswordLabel}
          hasRequirements
          autoComplete="new-password"
          value={password}
          error={passwordErrors.password}
          onChange={(value) => {
            setPassword(value);
            setPasswordErrors({});
          }}
        />

        <PasswordField
          label={content.auth.confirmPasswordLabel}
          autoComplete="new-password"
          value={confirmation}
          error={passwordErrors.confirmation}
          onChange={(value) => {
            setConfirmation(value);
            setPasswordErrors({});
          }}
        />
      </AuthForm>
    </AuthCard>
  );
}

interface SignupFieldErrors {
  workspaceName?: string;
  slug?: string;
  adminName?: string;
  email?: string;
}

/**
 * The visitor's own time zone, or `null`.
 *
 * Worth sending because the tenant's zone is what every report is bucketed in
 * (ADR 0009 decision 5), and the first administrator's browser is the best
 * evidence available at the moment the workspace is created — far better than
 * the provisioning default, which nobody chose.
 *
 * Checked against the **contract's** schema rather than trusted, for the reason
 * that schema exists: it resolves the name against the runtime's own zone
 * database, and the API's ICU build is not this browser's. A zone this one knows
 * and that one does not would otherwise fail the whole signup with
 * `validation_failed` over a field the customer never filled in.
 */
function resolveBrowserTimezone(): string | null {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return IanaTimezoneSchema.safeParse(resolved).success ? resolved : null;
}
