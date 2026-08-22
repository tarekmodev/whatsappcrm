'use client';

import { useState } from 'react';
import { CANNED_RESPONSE_LIMITS, type CannedResponseResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { CannedResponsesTable } from './CannedResponsesTable';
import { LazyCreateCannedResponseDialog } from './canned-response-dialogs.lazy';

/**
 * The saved-reply admin surface: the card, the create trigger and the table.
 * Usage: `<CannedResponsesPanel responses={responses} canManage />`.
 *
 * `canManage` comes from the server's permission check, so a role that cannot
 * write a saved reply is never rendered a button that leads to a refusal. The
 * server action asserts `canned_response:write` again regardless.
 */
export function CannedResponsesPanel({
  responses,
  canManage,
}: {
  responses: readonly CannedResponseResponse[];
  canManage: boolean;
}) {
  const content = useContent();
  const [isCreating, setIsCreating] = useState(false);

  // The cap the API enforces on create (0011). Offering the button anyway and
  // letting the request come back `conflict` would tell the admin nothing about
  // how to get out of it.
  const isAtLimit = responses.length >= CANNED_RESPONSE_LIMITS.perTenant;

  return (
    <SectionCard
      id="saved-replies"
      title={content.cannedResponses.listHeading}
      description={content.cannedResponses.listDescription(
        responses.length,
        CANNED_RESPONSE_LIMITS.perTenant,
      )}
      action={
        canManage && !isAtLimit ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            {content.cannedResponses.create}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="4">
        {canManage && isAtLimit ? (
          <Notice tone="warning">
            {content.cannedResponses.limitReachedNotice(CANNED_RESPONSE_LIMITS.perTenant)}
          </Notice>
        ) : null}

        <CannedResponsesTable responses={responses} canManage={canManage} />
      </Stack>

      {isCreating ? (
        <LazyCreateCannedResponseDialog
          onClose={() => {
            setIsCreating(false);
          }}
        />
      ) : null}
    </SectionCard>
  );
}
