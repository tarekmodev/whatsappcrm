'use client';

import { useCallback, useState } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { createTeamAction } from '../people.actions';
import { AgentSelectionField } from './AgentSelectionField';

/**
 * Creates a team, optionally with its initial members. Usage:
 * `<CreateTeamDialog users={users} onClose={…} />`.
 *
 * Members can be chosen here so that TAR-22's second acceptance criterion — a
 * team's conversations being visible to its members — holds from the moment the
 * team exists, without a second trip through the members dialog.
 */
export function CreateTeamDialog({
  users,
  onClose,
}: {
  users: readonly UserResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberUserIds, setMemberUserIds] = useState<readonly string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);

  const perform = useCallback(async () => {
    return createTeamAction({
      name: name.trim(),
      description: description.trim().length === 0 ? null : description.trim(),
      memberUserIds: [...memberUserIds],
    });
  }, [description, memberUserIds, name]);

  const onSuccess = useCallback(
    ({ name: createdName }: { name: string }) => {
      showToast({ tone: 'success', message: content.people.createTeamSuccess(createdName) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.people.createTeamTitle}
      description={content.people.createTeamDescription}
      submitLabel={content.people.createTeamSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        if (name.trim().length === 0) {
          setNameError(content.form.requiredFieldError);
          return;
        }

        setNameError(null);
        submit();
      }}
    >
      <Field label={content.people.teamNameLabel} error={nameError ?? undefined} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="name"
            autoComplete="off"
            placeholder={content.people.teamNamePlaceholder}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
        )}
      </Field>

      <Field label={content.people.teamDescriptionLabel} hint={content.common.optional}>
        {({ controlId, describedBy }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            name="description"
            autoComplete="off"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        )}
      </Field>

      <AgentSelectionField
        users={users}
        selectedUserIds={memberUserIds}
        onChange={setMemberUserIds}
      />
    </FormDialog>
  );
}
