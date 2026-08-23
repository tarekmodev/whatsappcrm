'use client';

import { useId } from 'react';
import { ASSIGNMENT_POLICY } from '@whatsappcrm/contracts';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { UsageMeter, type UsageMeterTone } from '@/components/ui/UsageMeter';
import { useContent } from '@/lib/content';
import type { AgentCapacityRow } from '../capacity';
import {
  effectiveTicketLimit,
  withLimit,
  withUsesDefault,
  type TicketLimitDraft,
} from '../capacity-input';
import styles from './AgentCapacityFields.module.css';

/**
 * One agent's limit, as read and as edited. Usage, inside the cap-edit dialog:
 * `<AgentCapacityFields row={row} workspaceDefault={5} draft={draft} onDraftChange={…} />`.
 *
 * Its own component because it has one reason to change — how a limit is shown
 * and typed — while the dialog around it owns the agent picker, the submit and
 * the toast. Controlled, so the dialog keeps a single draft it can send.
 *
 * **The reading is a `UsageMeter`, not a line of text.** With `value` and `max`
 * it is a real `progressbar`, so the proportion a supervisor is deciding on can
 * be reported on request — and the summary states the same two numbers in words,
 * which is what keeps it correct in forced-colors mode and for anyone who cannot
 * tell the tones apart. The bar never carries the fact alone.
 *
 * Order matters here and was got wrong once (TAR-778): heading, then the numbers,
 * then where the limit came from. The reading is the decision; provenance is the
 * footnote that stops the edit feeling arbitrary.
 */

/** Above this share of the cap the tone stops being neutral. */
const WARNING_RATIO = 0.8;

export function AgentCapacityFields({
  row,
  workspaceDefault,
  draft,
  error,
  isDisabled,
  onDraftChange,
}: {
  row: AgentCapacityRow;
  /** The cap an agent with no override of their own inherits. */
  workspaceDefault: number;
  draft: TicketLimitDraft;
  /** Set after a submit attempt, never while typing. */
  error?: string;
  isDisabled: boolean;
  onDraftChange: (draft: TicketLimitDraft) => void;
}) {
  const content = useContent();
  const useDefaultId = useId();
  const { activeTicketCount, effectiveMaxConcurrentTickets } = row.capacity;
  const ratio = activeTicketCount / effectiveMaxConcurrentTickets;

  // The effective limit, so ticking "use the workspace default" is checked
  // against the same rule as typing a number — one condition, not two.
  const effective = effectiveTicketLimit(draft, workspaceDefault);
  const isBelowLoad = effective !== null && effective < activeTicketCount;

  return (
    <>
      {/* Polite, and around the whole meter: changing agent in the picker above
          replaces every part of this reading at once, so one announcement is
          the honest number of announcements. */}
      <div role="status" className={styles.reading}>
        <UsageMeter
          heading={content.assignment.raiseLimitLoadHeading}
          summary={content.assignment.raiseLimitLoadSummary(
            activeTicketCount,
            effectiveMaxConcurrentTickets,
          )}
          ratio={ratio}
          value={activeTicketCount}
          max={effectiveMaxConcurrentTickets}
          tone={loadTone(ratio)}
        >
          {row.capacity.maxConcurrentTickets === null
            ? content.assignment.raiseLimitInherited(workspaceDefault)
            : content.assignment.raiseLimitOverridden}
        </UsageMeter>
      </div>

      <Field
        label={content.assignment.raiseLimitValueLabel}
        hint={content.assignment.raiseLimitValueHint(
          ASSIGNMENT_POLICY.minMaxConcurrentTickets,
          ASSIGNMENT_POLICY.maxMaxConcurrentTickets,
        )}
        error={error}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            className={styles.limit}
            name="maxConcurrentTickets"
            type="number"
            inputMode="numeric"
            min={ASSIGNMENT_POLICY.minMaxConcurrentTickets}
            max={ASSIGNMENT_POLICY.maxMaxConcurrentTickets}
            step={1}
            value={draft.limit}
            // Disabled while the box below is ticked, rather than removed: a
            // field that vanishes takes the supervisor's place in the form with
            // it, and the number it shows *is* the limit that would apply.
            disabled={isDisabled || draft.usesDefault}
            onChange={(event) => {
              onDraftChange(withLimit(event.target.value));
            }}
          />
        )}
      </Field>

      {/* Under the field, because it modifies the field. The label carries the
          number, so no group heading above it — `raiseLimitInherited` under the
          meter already says where a limit comes from, and a legend here would be
          the third statement of one fact inside one dialog. */}
      <label className={styles.useDefault} htmlFor={useDefaultId}>
        <Checkbox
          id={useDefaultId}
          name="usesDefault"
          checked={draft.usesDefault}
          disabled={isDisabled}
          onChange={(event) => {
            onDraftChange(withUsesDefault(draft, event.target.checked, workspaceDefault));
          }}
        />
        <span className={styles.useDefaultLabel}>
          {content.assignment.raiseLimitUseDefaultLabel(workspaceDefault)}
        </span>
      </label>

      {/* ADR 0008's failure-mode table: a limit below what somebody already holds
          takes none of it away, which reads as a bug from the queue. Said before
          the button rather than discovered after it — and it fires for a ticked
          workspace default below the load just as it does for a typed one. */}
      {isBelowLoad ? (
        <Notice tone="warning">
          {content.assignment.raiseLimitBelowLoad(
            row.user.displayName,
            activeTicketCount,
            effective,
          )}
        </Notice>
      ) : null}
    </>
  );
}

/** Neutral until the agent is close to their cap, danger once they are on it. */
function loadTone(ratio: number): UsageMeterTone {
  if (ratio >= 1) {
    return 'danger';
  }

  return ratio >= WARNING_RATIO ? 'warning' : 'accent';
}
