'use client';

import { useCallback, useRef, useState } from 'react';
import { IdSchema, type AdminWebhookEventReplayResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SectionCard } from '@/components/ui/SectionCard';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { replayWebhookEventAction } from '../webhooks.actions';
import styles from './WebhookReplayForm.module.css';

/**
 * Replaying a parked inbound event — **a form, not a queue** (spec §2.9).
 *
 * There is no endpoint that lists webhook events. The controller has exactly one
 * route and its own comment says it "is deliberately not the beginning of a
 * webhook browser"; TAR-67 gives operators a SQL query in the README instead. A
 * UI that presented a queue here would be a queue with nothing to fill it, so the
 * card names the runbook rather than pretending.
 *
 * **No confirmation dialog.** A replay is a status reset, not a destruction, and
 * the `409`-on-repeat below is a better guard than a dialog an operator learns to
 * click through.
 *
 * ## The session log
 *
 * Every replay attempted in this tab, newest first, and the card says it is not
 * saved. An operator working through a batch of ids needs to see what they have
 * already done, and with no list endpoint behind it this is the cheapest honest
 * way to give it to them.
 */
export function WebhookReplayForm() {
  const [eventId, setEventId] = useState('');
  const [idError, setIdError] = useState<string | undefined>(undefined);
  const [log, setLog] = useState<readonly AdminWebhookEventReplayResponse[]>([]);
  /**
   * What the **last submit** did, which is not the same as what the log holds.
   *
   * Binding the success notice to `log[0]` meant it rendered whenever the log was
   * non-empty — so after one good replay, a *failed* second attempt showed the
   * failure above the field and "Reset for reprocessing…" still sitting below it:
   * two contradictory verdicts on one submit. This is the attempt, and it is
   * cleared the moment another one starts.
   */
  const [outcome, setOutcome] = useState<AdminWebhookEventReplayResponse | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const perform = useCallback(
    async () => replayWebhookEventAction({ webhookEventId: eventId.trim() }),
    [eventId],
  );

  const onSuccess = useCallback((replayed: AdminWebhookEventReplayResponse) => {
    setOutcome(replayed);
    setLog((entries) => [replayed, ...entries]);
    setEventId('');
    // A batch is the normal case, so the caret goes back where the next id is
    // typed rather than being left on a button.
    fieldRef.current?.focus();
  }, []);

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform,
    onSuccess,
  });

  /*
   * §2.9 puts the API's `404` and `409` on the **field**: the operator is working
   * a batch, and the thing that is wrong is the id they just typed. `useActionForm`
   * reports every refusal as a form-level message, so it is moved here — the
   * `409` verbatim, because it names the status the event is really in and nothing
   * this console could compose beats that.
   */
  const fieldError =
    idError ??
    (formError === null
      ? undefined
      : requestId === null
        ? formError
        : content.errors.withReference(formError, requestId));

  return (
    <Stack gap="5">
      <SectionCard
        id="replay"
        title={content.webhooks.replayHeading}
        description={
          <>
            {content.webhooks.replayDescription}{' '}
            <TextLink href={content.webhooks.runbookHref} isExternal>
              {content.webhooks.runbookLink}
            </TextLink>
          </>
        }
      >
        <form
          noValidate
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();

            /*
             * The previous attempt's failure goes first, whichever way this one
             * ends. `submit()` clears it on the path that reaches the API, and the
             * two refusals below return before it — which would otherwise leave
             * "no stored webhook event has that id" sitting above a field error
             * about a *different* id the console never sent anywhere.
             */
            clearError();
            // The previous attempt's *verdict* goes with it, so a new submit
            // never renders last time's success beside this time's failure.
            setOutcome(null);

            const candidate = eventId.trim();

            if (candidate.length === 0) {
              setIdError(content.webhooks.idRequiredError);
              return;
            }

            // `IdSchema` is what the API validates the path parameter with, so a
            // paste that lost a character is caught here rather than as a round
            // trip.
            if (!IdSchema.safeParse(candidate).success) {
              setIdError(content.webhooks.idInvalidError);
              return;
            }

            setIdError(undefined);
            submit();
          }}
        >
          <Stack gap="4">
            {/*
              The submit lives **inside** the field's control row rather than
              beside the whole field, and that is what keeps the two aligned in
              every state. `Field` stacks label-and-hint above the control and the
              error below it, so a button aligned to the field's box lands level
              with whichever of those happens to be rendered — it dropped by a
              line the moment the id was invalid. Here it is a sibling of the
              input, so it sits on the control's line by construction and the
              error renders under both.
            */}
            <Field
              label={content.webhooks.idLabel}
              hint={content.webhooks.idHint}
              error={fieldError}
              isRequired
            >
              {({ controlId, describedBy, isInvalid }) => (
                <div className={styles.controlRow}>
                  <TextInput
                    ref={fieldRef}
                    id={controlId}
                    aria-describedby={describedBy}
                    aria-invalid={isInvalid}
                    className={styles.mono}
                    name="webhookEventId"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={eventId}
                    onChange={(event) => {
                      setEventId(event.target.value);
                      setIdError(undefined);
                    }}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    isPending={isPending}
                    pendingLabel={content.webhooks.pending}
                  >
                    {content.webhooks.submit}
                  </Button>
                </div>
              )}
            </Field>

            {outcome === null ? null : (
              <Stack gap="3">
                {/*
                  The copy must not overclaim: the API is explicit that
                  `replayedAt` is when the reset committed, not when the event was
                  reprocessed.
                */}
                <Notice tone="success">{content.webhooks.replayedNotice}</Notice>
                {outcome.provider === 'whatsapp' ? null : (
                  <Notice tone="warning">{content.webhooks.providerNotSweptNotice}</Notice>
                )}
              </Stack>
            )}
          </Stack>
        </form>
      </SectionCard>

      <SectionCard
        id="session-log"
        title={content.webhooks.logHeading}
        description={content.webhooks.logNotSaved}
      >
        {log.length === 0 ? (
          <EmptyState
            icon="checklist"
            tone="quiet"
            title={content.webhooks.logEmptyTitle}
            description={content.webhooks.logEmpty}
          />
        ) : (
          <ul className={styles.log}>
            {log.map((entry) => (
              <li key={`${entry.id}-${entry.replayedAt}`} className={styles.entry}>
                <DetailList items={entryItems(entry)} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </Stack>
  );
}

/**
 * One replay, as a report.
 *
 * `parkedError` is the reason being recovered and is the field that makes a run
 * against several ids read as a report rather than as a list of ids. `provider`
 * decides *which* sweeper collects the row, and only the WhatsApp one runs today.
 */
function entryItems(entry: AdminWebhookEventReplayResponse): DetailListItem[] {
  return [
    {
      id: 'id',
      term: content.webhooks.resultId,
      value: <span className={styles.mono}>{entry.id}</span>,
    },
    { id: 'provider', term: content.webhooks.resultProvider, value: entry.provider },
    {
      id: 'parked',
      term: content.webhooks.resultParkedError,
      value: entry.parkedError ?? content.webhooks.resultNoParkedError,
    },
    {
      id: 'at',
      term: content.webhooks.resultReplayedAt,
      value: (
        <RelativeTime isoTimestamp={entry.replayedAt} label={content.webhooks.resultReplayedAt} />
      ),
    },
  ];
}
