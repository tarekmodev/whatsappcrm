'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { SLA_DEFAULTS, type SlaPolicyResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import {
  SettingsForm,
  SettingsFormActions,
  SettingsFormSection,
} from '@/components/ui/SettingsForm';
import { Switch } from '@/components/ui/Switch';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { formatMinutes } from '@/lib/format/duration';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateSlaWindowAction } from '../sla-policies.actions';
import {
  SLA_WINDOW_MAX_MINUTES,
  SLA_WINDOW_MIN_MINUTES,
  parseWindow,
  toWindowInput,
  validateWindows,
  type WindowErrors,
} from '../window-form';
import styles from './SlaWindowForm.module.css';

/**
 * The workspace's response window: whether new tickets get a deadline at all,
 * and the two windows they get. Usage:
 * `<SlaWindowForm policy={defaultPolicy} />`.
 *
 * A real `<form>` with a real submit, and every control wired through `Field`
 * once, so none can be shipped without a label and an error slot. The layout is
 * `SettingsForm`'s — name and explanation leading, control trailing — matching
 * every other settings screen.
 *
 * **The switch is first**, and it is the only control here that changes what a
 * customer's ticket looks like tomorrow: a supervisor turning deadlines off in a
 * hurry should not have to read two number fields to find it.
 *
 * ## What this form deliberately cannot do
 *
 * `priority` and `businessHoursOnly` are on the policy and absent from the write
 * schema — the first belongs with the per-priority UI that is out of scope, and
 * the second is modelled but not implemented. There is no control for either,
 * which is the honest rendering of a field that does nothing.
 *
 * ## Editing here never moves a deadline that is already running
 *
 * A timer carries the `dueAt` written when it started, so shortening the window
 * cannot retroactively make yesterday's tickets overdue. The card says so above
 * this form rather than leaving a supervisor to discover it.
 */
export function SlaWindowForm({ policy }: { policy: SlaPolicyResponse }) {
  const content = useContent();
  const copy = content.slaSettings;
  const { showToast } = useToast();
  const [isActive, setIsActive] = useState(policy.isActive);
  const [firstResponse, setFirstResponse] = useState(
    toWindowInput(policy.firstResponseMinutes),
  );
  const [resolution, setResolution] = useState(toWindowInput(policy.resolutionMinutes));
  const [fieldErrors, setFieldErrors] = useState<WindowErrors>({});
  const firstResponseRef = useRef<HTMLInputElement>(null);
  const resolutionRef = useRef<HTMLInputElement>(null);

  const perform = useCallback(async () => {
    // Parsed rather than re-validated: the submit handler below refuses to call
    // this until both fields parse, so `null` here is an emptied field — "no
    // deadline of this kind", which is what the contract spells `null`.
    return updateSlaWindowAction(policy.id, {
      isActive,
      firstResponseMinutes: parseWindow(firstResponse) ?? null,
      resolutionMinutes: parseWindow(resolution) ?? null,
    });
  }, [firstResponse, isActive, policy.id, resolution]);

  const onSuccess = useCallback(() => {
    // Nothing is cleared and nothing is re-seeded from the response: the values
    // on screen are the ones just saved, and the server re-renders the page
    // behind this anyway.
    showToast({ tone: 'success', message: copy.savedToast });
  }, [copy, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <SettingsForm
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const errors = validateWindows({ firstResponse, resolution });

        setFieldErrors(errors);

        if (Object.keys(errors).length > 0) {
          // The cursor goes to the first field that is wrong, in the order they
          // appear: an error below a control somebody has scrolled past is an
          // error nobody reads.
          const firstInvalid =
            errors.firstResponse === undefined ? resolutionRef.current : firstResponseRef.current;

          firstInvalid?.focus();

          return;
        }

        submit();
      }}
    >
      <SettingsFormSection>
        <Field label={copy.activeLabel} hint={copy.activeHint}>
          {({ controlId, describedBy }) => (
            <Switch
              id={controlId}
              aria-describedby={describedBy}
              name="isActive"
              isChecked={isActive}
              stateLabel={isActive ? copy.activeOn : copy.activeOff}
              onChange={setIsActive}
            />
          )}
        </Field>

        <Field
          label={copy.firstResponseLabel}
          // The platform's own setting, phrased rather than repeated as a
          // figure: "1 hour" is what a supervisor is deciding about, and 60 is
          // only how it is stored.
          hint={copy.firstResponseHint(formatMinutes(SLA_DEFAULTS.firstResponseMinutes, content))}
          error={fieldErrors.firstResponse}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              ref={firstResponseRef}
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              className={styles.window}
              // `inputMode` as well as `type`: it is what puts a numeric keypad
              // in front of somebody editing this on a phone.
              type="number"
              inputMode="numeric"
              name="firstResponseMinutes"
              min={SLA_WINDOW_MIN_MINUTES}
              max={SLA_WINDOW_MAX_MINUTES}
              step={1}
              value={firstResponse}
              onChange={(event) => {
                setFirstResponse(event.target.value);
                setFieldErrors({});
              }}
            />
          )}
        </Field>

        <Field
          label={copy.resolutionLabel}
          hint={copy.resolutionHint}
          error={fieldErrors.resolution}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              ref={resolutionRef}
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              className={styles.window}
              type="number"
              inputMode="numeric"
              name="resolutionMinutes"
              min={SLA_WINDOW_MIN_MINUTES}
              max={SLA_WINDOW_MAX_MINUTES}
              step={1}
              value={resolution}
              onChange={(event) => {
                setResolution(event.target.value);
                setFieldErrors({});
              }}
            />
          )}
        </Field>
      </SettingsFormSection>

      {/* Inline, above the action, rather than a toast: a save that failed is
          about this form, and a message that slides away takes the reason with
          it while the user is still looking at the fields that caused it. */}
      <FormError message={formError} requestId={requestId} />

      <SettingsFormActions>
        {/* The fields stay editable while this is pending: a save in flight is
            not a reason to stop somebody correcting a typo they just spotted. */}
        <Button type="submit" variant="primary" isPending={isPending}>
          {copy.save}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}
