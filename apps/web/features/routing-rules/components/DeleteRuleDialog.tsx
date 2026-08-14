'use client';

import { useCallback } from 'react';
import type { AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { deleteRoutingRuleAction } from '../routing-rules.actions';

/**
 * Confirms deleting a routing rule. Usage:
 * `<DeleteRuleDialog rule={rule} onClose={…} />`.
 *
 * Confirmed rather than offered as an undo, because there is nothing to undo it
 * with: the API has no restore, and a rule is a standing instruction about where
 * customer conversations go. The copy names the rule and says what does *not*
 * change — conversations it already routed keep their assignment — rather than
 * asking "are you sure?".
 */
export function DeleteRuleDialog({
  rule,
  onClose,
}: {
  rule: AssignmentRuleResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const { showToast } = useToast();

  const perform = useCallback(async () => {
    return deleteRoutingRuleAction(rule.id, rule.name);
  }, [rule.id, rule.name]);

  const onSuccess = useCallback(
    ({ name }: { name: string }) => {
      showToast({ tone: 'success', message: copy.deleteSuccess(name) });
      onClose();
    },
    [copy, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={copy.deleteRuleTitle}
      submitLabel={copy.deleteRuleConfirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <p>{copy.deleteRuleBody(rule.name)}</p>
    </FormDialog>
  );
}
