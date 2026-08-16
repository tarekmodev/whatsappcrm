'use client';

import { useCallback, useState, type FormEvent } from 'react';
import type { TenantResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateWorkspaceProfileAction } from '../workspace.actions';
import { validateProfile, WORKSPACE_NAME_MAX_LENGTH, type ProfileErrors } from '../profile-form';
import { workspaceHostname } from './WorkspaceProfileDetails';
import styles from './WorkspaceProfileForm.module.css';

/**
 * The editable half of the workspace profile: its name and the support address
 * customers are told to write to. Usage:
 * `<WorkspaceProfileForm tenant={tenant} />`.
 *
 * A real `<form>` with a real submit, so Enter in either field saves — and the
 * two `Field`s wire label, hint and error to their control once each rather than
 * being hand-assembled.
 *
 * **The support address lives under `branding`** in `TenantUpdateInput`, which is
 * where the contract puts it and where TAR-29's editor will find it. It is on
 * this form rather than in the branding section below because it is a contact
 * detail an admin changes when their support alias changes, not a visual choice
 * they make once.
 *
 * The submitted body is deliberately partial — `{ name, branding: { supportEmail } }`
 * — so saving a renamed workspace cannot clobber a colour this form never showed.
 */
export function WorkspaceProfileForm({ tenant }: { tenant: TenantResponse }) {
  const content = useContent();
  const { showToast } = useToast();
  const [name, setName] = useState(tenant.name);
  const [supportEmail, setSupportEmail] = useState(tenant.branding.supportEmail ?? '');
  const [fieldErrors, setFieldErrors] = useState<ProfileErrors>({});

  const perform = useCallback(async () => {
    return updateWorkspaceProfileAction({
      name: name.trim(),
      // An emptied field means "there is no support address", which the contract
      // spells `null`. Sending `''` would fail its `z.email()` and read to the
      // user as a validation bug rather than as a cleared field.
      branding: { supportEmail: supportEmail.trim() === '' ? null : supportEmail.trim() },
    });
  }, [name, supportEmail]);

  const onSuccess = useCallback(() => {
    // No fields are cleared and nothing is re-seeded from the response: the
    // values on screen are the ones that were just saved, and the server
    // re-renders the page behind this anyway.
    showToast({ tone: 'success', message: content.workspace.profileSavedToast });
  }, [content, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const errors = validateProfile({ name, supportEmail });

        setFieldErrors(errors);

        if (Object.keys(errors).length === 0) {
          submit();
        }
      }}
    >
      <Stack gap="4">
        <Field label={content.workspace.nameLabel} error={fieldErrors.name} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              name="workspaceName"
              value={name}
              maxLength={WORKSPACE_NAME_MAX_LENGTH}
              autoComplete="organization"
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                setName(event.target.value);
                setFieldErrors({});
              }}
            />
          )}
        </Field>

        <Field
          label={content.workspace.supportEmailLabel}
          hint={content.workspace.supportEmailHint}
          error={fieldErrors.supportEmail}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              name="supportEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={supportEmail}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                setSupportEmail(event.target.value);
                setFieldErrors({});
              }}
            />
          )}
        </Field>

        {/*
          Text rather than a disabled input, which is the rule `StaticFieldValue`
          exists for: the address can never be changed here — the slug it is built
          from is immutable by contract — and a disabled control reads as "not
          right now" while also being skipped by keyboard navigation.
        */}
        <Field label={content.workspace.addressLabel} hint={content.workspace.addressHint}>
          {({ controlId }) => (
            <StaticFieldValue id={controlId}>
              {workspaceHostname(tenant) ?? content.workspace.addressEmpty}
            </StaticFieldValue>
          )}
        </Field>

        <FormError message={formError} requestId={requestId} />

        <Cluster justify="end">
          <Button type="submit" variant="primary" isPending={isPending}>
            {content.workspace.saveProfile}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
