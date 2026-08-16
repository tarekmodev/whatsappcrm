'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ContactResponse, CustomFieldDefinition } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { saveContactCustomFieldsAction } from '../contacts.actions';
import {
  changedCustomFieldKeys,
  customFieldDraft,
  customFieldIssues,
  customFieldPatch,
  type CustomFieldDraft,
} from '../custom-field-values';
import { ContactCustomFieldsDetails } from './ContactCustomFieldsDetails';
import { CustomFieldControl } from './CustomFieldControl';
import styles from './ContactCustomFieldsCard.module.css';

/**
 * The tenant's custom fields on one contact, editable. Usage:
 * `<ContactCustomFieldsCard contact={contact} definitions={definitions} canWrite />`.
 *
 * The form is rendered from the **definition list**, in `position` order, and the
 * values are read out of `contact.customFields` by `key` — the shape 0002
 * amendment 10 rules. A key the contact has never been given is absent from that
 * map rather than `null`, which is why the draft is built from the definitions
 * and not from the value map.
 *
 * Only the fields the agent actually changed are sent, as a merge patch. An
 * emptied control becomes an explicit `null` that clears one; every other key is
 * left exactly as it was, so two agents editing different fields do not overwrite
 * each other.
 */

export interface ContactCustomFieldsCardProps {
  contact: ContactResponse;
  definitions: readonly CustomFieldDefinition[];
  canWrite: boolean;
  /** Whether this principal may reach the screen that defines a field. */
  canManageDefinitions: boolean;
}

export function ContactCustomFieldsCard({
  contact,
  definitions,
  canWrite,
  canManageDefinitions,
}: ContactCustomFieldsCardProps) {
  const content = useContent();
  const { showToast } = useToast();

  const initial = useMemo(
    () => customFieldDraft(definitions, contact.customFields),
    [definitions, contact.customFields],
  );
  const [draft, setDraft] = useState<CustomFieldDraft>(initial);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  const hasChanges = changedCustomFieldKeys(definitions, initial, draft).length > 0;

  const perform = useCallback(async () => {
    const customFields = customFieldPatch(definitions, initial, draft);

    return saveContactCustomFieldsAction(contact.id, contact.displayName, {
      // `customFieldPatch` returns `null` only when nothing changed, and submit
      // is blocked in that case — so this is an empty merge the API never sees.
      customFields: customFields ?? {},
    });
  }, [contact.displayName, contact.id, definitions, draft, initial]);

  const onSuccess = useCallback(
    ({ displayName }: { displayName: string }) => {
      showToast({ tone: 'success', message: content.contacts.customFieldsSaved(displayName) });
      setIssues({});
    },
    [content, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  if (definitions.length === 0) {
    return (
      <SectionCard id="custom-fields" title={content.contacts.customFieldsHeading}>
        <EmptyState
          heading={content.contacts.customFieldsEmptyHeading}
          body={
            canManageDefinitions
              ? content.contacts.customFieldsEmptyBody
              : content.contacts.customFieldsEmptyBodyReadOnly
          }
          action={
            canManageDefinitions ? (
              <TextLink href={routes.settingsCustomFields()}>
                {content.contacts.customFieldsEmptyAction}
              </TextLink>
            ) : undefined
          }
        />
      </SectionCard>
    );
  }

  if (!canWrite) {
    return (
      <SectionCard
        id="custom-fields"
        title={content.contacts.customFieldsHeading}
        description={content.contacts.readOnlyHint}
      >
        <ContactCustomFieldsDetails contact={contact} definitions={definitions} />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="custom-fields"
      title={content.contacts.customFieldsHeading}
      description={content.contacts.customFieldsDescription}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();

          const found = customFieldIssues(definitions, initial, draft);

          setIssues(found);

          if (Object.keys(found).length === 0) {
            submit();
          }
        }}
      >
        <Stack gap="4">
          <FormError message={formError} requestId={requestId} />

          {definitions.map((definition) => (
            <CustomFieldControl
              key={definition.id}
              definition={definition}
              value={draft[definition.key] ?? ''}
              error={issues[definition.key]}
              isDisabled={isPending}
              onChange={(value) => {
                setDraft((current) => ({ ...current, [definition.key]: value }));
                // Clears this field's message as soon as it is edited, rather
                // than leaving a stale error under a value the user has fixed.
                setIssues((current) => {
                  if (current[definition.key] === undefined) {
                    return current;
                  }

                  const next = { ...current };

                  delete next[definition.key];

                  return next;
                });
              }}
            />
          ))}

          <Cluster justify="end" align="center">
            {/* Says why the button will not press, rather than leaving a dead
                control the user pokes at. */}
            {hasChanges ? null : (
              <p className={styles.unchanged}>{content.contacts.customFieldsUnchanged}</p>
            )}
            <Button type="submit" variant="primary" isPending={isPending} disabled={!hasChanges}>
              {content.contacts.saveCustomFields}
            </Button>
          </Cluster>
        </Stack>
      </form>
    </SectionCard>
  );
}
