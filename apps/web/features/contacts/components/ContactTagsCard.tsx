'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ContactResponse, Tag } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup, type CheckboxOption } from '@/components/ui/CheckboxGroup';
import { Cluster } from '@/components/layout/Cluster';
import { FormError } from '@/components/ui/FormError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { saveContactTagsAction } from '../contacts.actions';
import { contactTagPatch } from '../custom-field-values';
import { ContactTagList } from './ContactTagList';

/**
 * Add and remove a contact's tags. Usage:
 * `<ContactTagsCard contact={contact} tags={tags} canWrite={canWrite} />`.
 *
 * Checkboxes rather than a custom token input: the tag vocabulary is a short,
 * known list capped by the same read the filter uses, and a `fieldset` of
 * checkboxes is keyboard-operable and announced correctly with no JavaScript of
 * its own. It is the same control the routing-rule builder picks tags with, so
 * the two surfaces behave identically.
 *
 * A tag the contact holds that is no longer in the vocabulary keeps its row,
 * checked, so it can be unchecked. Dropping it would mean the only way to remove
 * it is an API call the console does not offer.
 */

export interface ContactTagsCardProps {
  contact: ContactResponse;
  /** The tenant's whole tag vocabulary. */
  tags: readonly Tag[];
  canWrite: boolean;
}

export function ContactTagsCard({ contact, tags, canWrite }: ContactTagsCardProps) {
  const content = useContent();
  const { showToast } = useToast();

  const initialTagIds = useMemo(() => contact.tags.map((tag) => tag.id), [contact.tags]);
  const [selectedTagIds, setSelectedTagIds] = useState<readonly string[]>(initialTagIds);

  const options = useMemo(
    () => tagOptions(tags, contact.tags, content.contacts.tagsUnknownHint),
    [contact.tags, content, tags],
  );
  const hasChanges = contactTagPatch(initialTagIds, selectedTagIds) !== null;

  const perform = useCallback(async () => {
    return saveContactTagsAction(contact.id, contact.displayName, { tagIds: [...selectedTagIds] });
  }, [contact.displayName, contact.id, selectedTagIds]);

  const onSuccess = useCallback(
    ({ displayName }: { displayName: string }) => {
      showToast({ tone: 'success', message: content.contacts.tagsSaved(displayName) });
    },
    [content, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  if (!canWrite) {
    return (
      <SectionCard
        id="tags"
        title={content.contacts.tagsHeading}
        description={content.contacts.readOnlyHint}
      >
        <ContactTagList tags={contact.tags} />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="tags"
      title={content.contacts.tagsHeading}
      description={content.contacts.tagsDescription}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Stack gap="4">
          <FormError message={formError} requestId={requestId} />

          <CheckboxGroup
            legend={content.contacts.tagsFieldLabel}
            name="tagIds"
            options={options}
            selectedValues={selectedTagIds}
            onChange={setSelectedTagIds}
            emptyLabel={content.contacts.tagsEmptyLabel}
          />

          <Cluster justify="end">
            <Button type="submit" variant="primary" isPending={isPending} disabled={!hasChanges}>
              {content.contacts.saveTags}
            </Button>
          </Cluster>
        </Stack>
      </form>
    </SectionCard>
  );
}

/**
 * The vocabulary, plus any tag this contact holds that is no longer in it.
 *
 * `TagSchema` guarantees a unique id per tag but the two lists can overlap, so
 * the held tags are appended only when the vocabulary does not already carry
 * them — otherwise the same tag would render twice with the same checkbox value.
 */
function tagOptions(
  vocabulary: readonly Tag[],
  held: readonly Tag[],
  unknownHint: string,
): CheckboxOption[] {
  const known = new Set(vocabulary.map((tag) => tag.id));

  return [
    ...vocabulary.map((tag) => ({ value: tag.id, label: tag.name })),
    ...held
      .filter((tag) => !known.has(tag.id))
      .map((tag) => ({ value: tag.id, label: tag.name, hint: unknownHint })),
  ];
}
