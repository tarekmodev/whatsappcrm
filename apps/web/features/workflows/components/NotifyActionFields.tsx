'use client';

import {
  WORKFLOW_FIELD_LENGTHS,
  WORKFLOW_NOTIFY_AUDIENCES,
  workflowNotifyAudienceTarget,
  type WorkflowAction,
  type WorkflowNotifyAudience,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useContent } from '@/lib/content';
import {
  labelledOptions,
  teamOptions,
  userOptions,
  withNotifyAudience,
  withPlaceholder,
} from '../builder';
import type { WorkflowVocabulary } from '../presentation';

type NotifyAction = Extract<WorkflowAction, { type: 'notify' }>;

/**
 * "Notify the supervisors: unresolved for 4 hours." Usage: rendered by
 * `ActionFields` for a `notify` action.
 *
 * The audience decides which second control appears, and switching it clears
 * whichever id the previous audience carried — the contract refines on exactly
 * that, so normalising here is what stops a draft being refused for a field the
 * form is no longer showing.
 *
 * The note is optional and is not a template: it is shown verbatim, with no
 * interpolation at v1. The hint says the ticket number is included anyway, so
 * nobody types `#{number}` and waits for it to be substituted (ADR 0009 risk 6).
 */
export function NotifyActionFields({
  action,
  vocabulary,
  error,
  onChange,
}: {
  action: NotifyAction;
  vocabulary: WorkflowVocabulary;
  error?: string;
  onChange: (action: WorkflowAction) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  // The cap is the contract's, not the content layer's: a `maxLength` that
  // disagreed with the schema would silently truncate what the user typed.
  const maxLength = WORKFLOW_FIELD_LENGTHS.notifyMessage;
  const target = workflowNotifyAudienceTarget(action.audience);

  return (
    <>
      <Field label={copy.notifyAudienceLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={action.audience}
            options={labelledOptions(WORKFLOW_NOTIFY_AUDIENCES, copy.notifyAudienceOptions)}
            onChange={(event) => {
              onChange(withNotifyAudience(action, event.target.value as WorkflowNotifyAudience));
            }}
          />
        )}
      </Field>

      {target === 'user' ? (
        <Field label={copy.notifyUserLabel} error={error} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={action.userId ?? ''}
              options={withPlaceholder(
                userOptions(vocabulary, action.userId),
                copy.notifyUserRequiredError,
              )}
              onChange={(event) => {
                onChange({ ...action, userId: event.target.value });
              }}
            />
          )}
        </Field>
      ) : null}

      {target === 'team' ? (
        <Field label={copy.notifyTeamLabel} error={error} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={action.teamId ?? ''}
              options={withPlaceholder(teamOptions(vocabulary), copy.notifyTeamRequiredError)}
              onChange={(event) => {
                onChange({ ...action, teamId: event.target.value });
              }}
            />
          )}
        </Field>
      ) : null}

      <Field
        label={copy.messageLabel}
        hint={copy.messageHint(maxLength)}
        error={target === null ? error : undefined}
      >
        {({ controlId, describedBy, isInvalid }) => (
          <Textarea
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="message"
            rows={2}
            maxLength={maxLength}
            value={action.message ?? ''}
            onChange={(event) => {
              onChange({ ...action, message: event.target.value });
            }}
          />
        )}
      </Field>
    </>
  );
}
