'use client';

import { useId, type Ref } from 'react';
import { Field } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { TextInput } from '@/components/ui/TextInput';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import type { SlugAvailabilityState } from '../useSlugAvailability';
import styles from './SignupSlugField.module.css';

/**
 * The workspace address, with the hostname it becomes and whether it is free.
 * Usage:
 *
 * ```tsx
 * <SignupSlugField value={slug} platformHost={platformHost} error={slugError}
 *                  availability={availability} onChange={setSlug} />
 * ```
 *
 * A component rather than a `Field` in the form body because it carries three
 * things a text input does not: a live preview of the hostname, an availability
 * state that arrives after the typing stops, and the rule that the second of
 * those must never be able to block a submit when it fails.
 *
 * ## The preview is built from the host this page is on
 *
 * `platformHost` is read server-side from the request that rendered the page and
 * passed down, not guessed here. It is the same host `TenantProvisioningService`
 * composes the subdomain against, so the line says what the address will
 * actually be — including on a developer's `localhost:3000`, where a hardcoded
 * production domain would have been a lie in the one environment somebody is
 * looking at it in.
 *
 * ## What is announced, and what is only shown
 *
 * The pending indicator is `aria-hidden`: it changes on every keystroke, and a
 * screen reader that said "checking" between each one would drown the answer.
 * The **settled** answer is the live region, so it is announced exactly once per
 * pause.
 *
 * "Taken" is announced there *and* rendered as the field's own error, because it
 * is the one outcome that has to stop the submit — `Field` derives `aria-invalid`
 * from `error`, and `AuthForm` sends focus to the first invalid control after a
 * rejected submit. The live region is deliberately **not** in `aria-describedby`
 * for that reason: it would make focusing the field read the same sentence
 * twice.
 */
export function SignupSlugField({
  value,
  platformHost,
  error,
  availability,
  onChange,
  inputRef,
}: {
  value: string;
  /** The host this page was served on — the platform's, never a tenant's. */
  platformHost: string;
  error?: string;
  availability: SlugAvailabilityState;
  onChange: (value: string) => void;
  /**
   * For the one case the form has to move focus here itself: a slug the *submit*
   * came back refusing, which lands a round trip after `AuthForm` has already
   * finished chasing invalid controls.
   */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const content = useContent();
  const previewId = useId();

  const settled = availability.status === 'settled' ? availability.availability : null;

  return (
    <Field
      label={content.auth.signupSlugLabel}
      hint={content.auth.signupSlugHint}
      error={error}
      isRequired
    >
      {({ controlId, describedBy, isInvalid }) => (
        <>
          <TextInput
            ref={inputRef}
            id={controlId}
            // The preview is a genuine description of what this control produces,
            // so it joins the hint and the error. The live region below is not.
            aria-describedby={
              [describedBy, value === '' ? null : previewId]
                .filter((id): id is string => id !== null && id !== undefined)
                .join(' ') || undefined
            }
            aria-invalid={isInvalid}
            name="slug"
            inputMode="url"
            // A hostname label is lowercase by definition, and the three that
            // follow are `PasswordField`'s reasoning: a keyboard that helpfully
            // capitalises or corrects this submits something nobody typed.
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(event) => {
              // Lower-cased on the way in rather than rejected afterwards.
              // `TenantSlugSchema` refuses an upper-case letter, and telling
              // somebody their capital A is invalid is a worse answer than
              // showing them the address they are actually getting.
              onChange(event.target.value.toLowerCase());
            }}
          />

          {/*
            Rendered only once there is something to preview, and the region
            reserves its own height so the first character typed does not push
            the rest of the form down by a line.
          */}
          <div className={styles.status}>
            {value === '' ? null : (
              <p id={previewId} className={styles.preview}>
                {content.auth.signupSlugPreviewLabel}{' '}
                {/* `<code>` for the same reason the settings screens use it for a
                    hostname: this is a literal to be read character by character,
                    and the mono face is what makes `rn` and `m` different. */}
                <code className={styles.hostname}>{`${value}.${platformHost}`}</code>
              </p>
            )}

            {availability.status === 'checking' ? (
              <p className={styles.pending} aria-hidden="true">
                <span className={styles.pulse} />
                {content.auth.signupSlugChecking}
              </p>
            ) : null}

            {/*
              One sentence per settled check, and nothing between them. `taken` is
              visually the field's error rather than a second red line saying the
              same thing, so here it is the announcement only.
            */}
            <p className={styles.answer} role="status" data-state={settled ?? 'none'}>
              {settled === null ? null : settled === 'taken' ? (
                <VisuallyHidden>{content.auth.signupSlugTakenError}</VisuallyHidden>
              ) : settled === 'available' ? (
                <>
                  {/* `Icon` is `aria-hidden` by construction, so the tick is a
                      second carrier beside the colour without becoming a second
                      thing the live region reads out. */}
                  <Icon name="check" size="sm" />
                  {content.auth.signupSlugAvailable}
                </>
              ) : (
                content.auth.signupSlugCheckUnavailable
              )}
            </p>
          </div>
        </>
      )}
    </Field>
  );
}
