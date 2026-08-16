'use client';

import { useState } from 'react';
import { CUSTOM_FIELD_LIMITS, type CustomFieldDefinition } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { CustomFieldsTable } from './CustomFieldsTable';
import { LazyCreateCustomFieldDialog } from './custom-field-dialogs.lazy';

/**
 * The definition admin surface: the card, the create trigger and the table.
 * Usage: `<CustomFieldsPanel definitions={definitions} canManage />`.
 *
 * `canManage` comes from the server's permission check, so a role that cannot
 * define a field is never rendered a button that leads to a refusal. The server
 * action asserts `tenant:settings` again regardless.
 */
export function CustomFieldsPanel({
  definitions,
  canManage,
}: {
  definitions: readonly CustomFieldDefinition[];
  canManage: boolean;
}) {
  const content = useContent();
  const [isCreating, setIsCreating] = useState(false);

  // The cap the API enforces on create. Offering the button anyway and letting
  // the request come back `conflict` would tell the admin nothing about how to
  // get out of it.
  const isAtLimit = definitions.length >= CUSTOM_FIELD_LIMITS.definitionsPerTenant;

  return (
    <SectionCard
      id="custom-fields"
      title={content.customFields.listHeading}
      description={content.customFields.listDescription(
        definitions.length,
        CUSTOM_FIELD_LIMITS.definitionsPerTenant,
      )}
      action={
        canManage && !isAtLimit ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            {content.customFields.create}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="4">
        {canManage && isAtLimit ? (
          <Notice tone="warning">
            {content.customFields.limitReachedNotice(CUSTOM_FIELD_LIMITS.definitionsPerTenant)}
          </Notice>
        ) : null}

        <CustomFieldsTable definitions={definitions} canManage={canManage} />
      </Stack>

      {isCreating ? (
        <LazyCreateCustomFieldDialog
          onClose={() => {
            setIsCreating(false);
          }}
        />
      ) : null}
    </SectionCard>
  );
}
