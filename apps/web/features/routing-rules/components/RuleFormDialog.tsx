'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ROUTING_RULE_FIELD_LENGTHS,
  type AssignmentRuleCreateInput,
  type AssignmentRuleResponse,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { createRoutingRuleAction, updateRoutingRuleAction } from '../routing-rules.actions';
import {
  draftFromRule,
  validateRuleDraft,
  type RuleDraft,
  type RuleDraftErrors,
} from '../rule-form';
import type { RoutingRuleVocabulary } from '../presentation';
import { ConditionListEditor } from './ConditionListEditor';
import { RuleTargetField } from './RuleTargetField';

/**
 * Writes a routing rule. Usage:
 * `<RuleFormDialog rule={rule} vocabulary={vocabulary} onClose={…} />` — omit
 * `rule` to create one. Mounted only while open, so its chunk loads on first use.
 *
 * One component for both, rather than a create dialog and an edit dialog that
 * differ by a title: the fields, the validation and the failure handling are
 * identical, and the two would drift the first time a condition type is added.
 *
 * `isActive` is carried through the draft and never edited here. The list owns
 * the on/off switch, so saving a name change cannot quietly turn a disabled rule
 * back on.
 */
export function RuleFormDialog({
  rule = null,
  vocabulary,
  onClose,
}: {
  rule?: AssignmentRuleResponse | null;
  vocabulary: RoutingRuleVocabulary;
  onClose: () => void;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const { showToast } = useToast();
  const [draft, setDraft] = useState<RuleDraft>(() => draftFromRule(rule));
  const [errors, setErrors] = useState<RuleDraftErrors>(NO_ERRORS);
  /**
   * What validation produced, handed to `perform` on the same tick `submit` is
   * called. A ref rather than state: a `setState` in the submit handler is not
   * visible to the callback that handler goes on to invoke, so the send would
   * always run one submit behind.
   */
  const validatedInputRef = useRef<AssignmentRuleCreateInput | null>(null);
  const isEditing = rule !== null;

  const perform = useCallback(async () => {
    const input = validatedInputRef.current;

    // Unreachable: `onSubmit` fills the ref before it calls `submit`.
    if (input === null) {
      throw new Error('Submitted a routing rule before it was validated.');
    }

    return isEditing ? updateRoutingRuleAction(rule.id, input) : createRoutingRuleAction(input);
  }, [isEditing, rule]);

  const onSuccess = useCallback(
    ({ name }: { name: string }) => {
      showToast({
        tone: 'success',
        message: isEditing ? copy.updateSuccess(name) : copy.createSuccess(name),
      });
      onClose();
    },
    [copy, isEditing, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  function update(change: Partial<RuleDraft>): void {
    setDraft((current) => ({ ...current, ...change }));
    setErrors(NO_ERRORS);
  }

  return (
    <FormDialog
      isOpen
      title={isEditing ? copy.editRuleTitle(rule.name) : copy.addRuleTitle}
      description={copy.conditionsHint}
      submitLabel={isEditing ? copy.editRuleSubmit : copy.addRuleSubmit}
      isPending={isPending}
      formError={errors.form ?? formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const validation = validateRuleDraft(draft, content);

        if (validation.status === 'invalid') {
          setErrors(validation.errors);
          return;
        }

        setErrors(NO_ERRORS);
        validatedInputRef.current = validation.input;
        submit();
      }}
    >
      {rule?.target === null ? <Notice tone="warning">{copy.targetMissingHint}</Notice> : null}

      <Field label={copy.nameLabel} hint={copy.nameHint} error={errors.name} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="name"
            autoComplete="off"
            maxLength={ROUTING_RULE_FIELD_LENGTHS.name}
            placeholder={copy.namePlaceholder}
            value={draft.name}
            onChange={(event) => {
              update({ name: event.target.value });
            }}
          />
        )}
      </Field>

      <ConditionListEditor
        conditions={draft.conditions}
        vocabulary={vocabulary}
        error={errors.conditions}
        errorsByCondition={errors.byCondition}
        onChange={(conditions) => {
          update({ conditions });
        }}
      />

      <RuleTargetField
        target={draft.target}
        teams={vocabulary.teams}
        users={vocabulary.users}
        error={errors.target}
        onChange={(target) => {
          update({ target });
        }}
      />
    </FormDialog>
  );
}

const NO_ERRORS: RuleDraftErrors = { byCondition: {} };
