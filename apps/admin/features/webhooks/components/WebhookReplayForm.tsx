'use client';

import { useCallback, useRef, useState } from 'react';
import { IdSchema, type AdminWebhookEventReplayResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SectionCard } from '@/components/ui/SectionCard';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { Cluster } from '@/components/layout/Cluster';
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
  const fieldRef = useRef<HTMLInputElement>(null);

  const perform = useCallback(
    async () => replayWebhookEventAction({ webhookEventId: eventId.trim() }),
    [eventId],
  );

  const onSuccess = useCallback((replayed: AdminWebhookEventReplayResponse) => {
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

  const latest = log[0];

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
            <FormError message={formError} requestId={requestId} />
            <Cluster gap="3" align="end" className={styles.row}>
              <div className={styles.field}>
                <Field
                  label={content.webhooks.idLabel}
                  hint={content.webhooks.idHint}
                  error={idError}
                  isRequired
                >
                  {({ controlId, describedBy, isInvalid }) => (
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
                  )}
                </Field>
              </div>
              <Button
                type="submit"
                variant="primary"
                isPending={isPending}
                pendingLabel={content.webhooks.pending}
              >
                {content.webhooks.submit}
              </Button>
            </Cluster>

            {latest === undefined ? null : (
              <Stack gap="3">
                {/*
                  The copy must not overclaim: the API is explicit that
                  `replayedAt` is when the reset committed, not when the event was
                  reprocessed.
                */}
                <Notice tone="success">{content.webhooks.replayedNotice}</Notice>
                {latest.provider === 'whatsapp' ? null : (
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
          <p>{content.webhooks.logEmpty}</p>
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
