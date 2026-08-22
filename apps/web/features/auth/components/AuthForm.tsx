'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import styles from './AuthForm.module.css';

/**
 * A page-level form with its error region, required legend, submit button,
 * pending state and double-submit guard wired once. Usage:
 *
 * ```tsx
 * <AuthForm submitLabel={…} pendingLabel={…} isPending={isPending} formError={formError} onSubmit={submit}>
 *   {fields}
 * </AuthForm>
 * ```
 *
 * `FormDialog` is the same idea for a modal; this is the one for a form that owns
 * its screen. All five password screens use it, so none of them can forget the
 * pending state or leave a failure unannounced.
 *
 * The submit button is full width and at least a touch target tall, because on
 * every screen that uses this it is the only primary action on the page.
 *
 * ## The three things it does that a bare `<form>` does not (TAR-521)
 *
 *   - **The legend.** Every `Field` marked required renders a `*`, and until now
 *     nothing on the page said what the `*` meant.
 *   - **Focus follows the failure.** A rejected submit leaves focus on the button
 *     at the bottom while the reason is above it; the effect below puts the
 *     caret in the first field that was rejected, which is also where the fix is.
 *   - **The fields are disabled while it submits**, not hidden and not left
 *     editable — typing into a field whose value has already been sent is a
 *     change that silently does not count.
 */
export function AuthForm({
  children,
  submitLabel,
  pendingLabel,
  onSubmit,
  isPending,
  formError,
  requestId,
  footer,
}: {
  children: ReactNode;
  submitLabel: string;
  /** What the button says while the request is in flight, e.g. "Signing in…". */
  pendingLabel?: string;
  onSubmit: () => void;
  isPending: boolean;
  formError: string | null;
  requestId?: string | null;
  /** Secondary navigation below the action, e.g. "Back to sign in". */
  footer?: ReactNode;
}) {
  const content = useContent();
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const [attempts, setAttempts] = useState(0);

  /*
   * After the render a submit attempt produced — not during the handler, where
   * the DOM still shows the previous render's validity. A pass leaves nothing
   * matching and does nothing, which is what makes this safe to run on every
   * attempt rather than on a flag the caller has to remember to set.
   */
  useEffect(() => {
    if (attempts === 0) {
      return;
    }

    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempts]);

  /*
   * Disabling a fieldset around the element that has focus takes that element out
   * of the tab order, and a keyboard user who submitted with Enter is left on
   * `<body>` mid-request. The button is the one control still enabled and is
   * where the pending state is announced, so focus goes there.
   *
   * Both conditions, because browsers disagree about which one it is: a real
   * browser blurs the field and lands on `<body>`, while jsdom leaves
   * `activeElement` on a control that `:disabled` now matches.
   */
  useEffect(() => {
    if (!isPending) {
      return;
    }

    const active = document.activeElement;
    const hasLostFocus = active === null || active === document.body;
    const isOnDisabledControl = active instanceof HTMLElement && active.matches(':disabled');

    if (hasLostFocus || isOnDisabledControl) {
      submitRef.current?.focus();
    }
  }, [isPending]);

  return (
    <form
      ref={formRef}
      noValidate
      className={styles.form}
      onSubmit={(event) => {
        // Validation is the contract's, and the submit is a server action.
        event.preventDefault();
        setAttempts((current) => current + 1);
        onSubmit();
      }}
    >
      <Stack gap="4">
        <FormError message={formError} requestId={requestId} shouldTakeFocus />
        {/* `disabled` on the fieldset rather than on each control: one attribute
            covers the fields a caller passes in, including any added later. */}
        <fieldset className={styles.fields} disabled={isPending}>
          <Stack gap="4">
            <p className={styles.legend}>{content.form.requiredLegend}</p>
            {children}
          </Stack>
        </fieldset>
        <Button
          ref={submitRef}
          type="submit"
          variant="primary"
          isBlock
          isPending={isPending}
          pendingLabel={pendingLabel}
        >
          {submitLabel}
        </Button>
        {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
      </Stack>
    </form>
  );
}
