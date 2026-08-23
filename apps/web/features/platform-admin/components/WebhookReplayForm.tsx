'use client';

import { useCallback, useState } from 'react';
import { IdSchema, type AdminWebhookEventReplayResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SectionCard } from '@/components/ui/SectionCard';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { replayWebhookEventAction } from '../platform-admin.actions';
import styles from './WebhookReplayForm.module.css';

/**
 * Puts one parked inbound event back in front of the sweeper. Usage:
 * `<WebhookReplayForm />`.
 *
 * ## Why it takes an id rather than showing a list
 *
 * `POST /admin/webhook-events/{id}/replay` is the *only* route on that
 * controller, and deliberately so — TAR-94 states it is not the beginning of a
 * webhook browser. The event id is the identity of the request, and the flagship
 * parked event is a number connected *after* its customers messaged it, so the
 * row names no tenant and could not be listed under one anyway. The operator
 * arrives with an id from `webhook_events`; the field's hint carries the query
 * that produces one, which is what makes a console with no list usable rather
 * than a dead end.
 *
 * ## The result stays on screen
 *
 * A toast says it worked and then leaves. What the operator actually needs is
 * `parkedError` — the reason being recovered — and `provider`, which decides
 * whether any sweeper will collect the row at all. Both are rendered below the
 * form and stay there, so a run against several events reads as a report.
 *
 * A repeat is a `409` naming the status the event is really in, and that message
 * is shown verbatim: "already processed" and "already received" mean different
 * next steps, and flattening them would leave an operator mid-incident believing
 * they had recovered a message they had not.
 */
export function WebhookReplayForm() {
  const content = useContent();
  const copy = content.platformAdmin.webhookEvents;
  const { showToast } = useToast();
  const [eventId, setEventId] = useState('');
  const [idError, setIdError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<AdminWebhookEventReplayResponse | null>(null);

  const perform = useCallback(
    async () => replayWebhookEventAction({ webhookEventId: eventId.trim() }),
    [eventId],
  );

  const onSuccess = useCallback(
    (replayed: AdminWebhookEventReplayResponse) => {
      setResult(replayed);
      showToast({ tone: 'success', message: copy.replayedToast(replayed.id) });
      // Cleared on success only: a rejected id must stay in the field so the
      // operator can see what they pasted and fix it.
      setEventId('');
    },
    [copy, showToast],
  );

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform,
    onSuccess,
  });

  return (
    <Stack gap="5">
      <SectionCard
        id="webhook-replay"
        title={copy.replayHeading}
        description={copy.replayDescription}
      >
        <Stack gap="4">
          <Notice tone="info" variant="quiet">
            {copy.noListNotice}
          </Notice>

          <form
            noValidate
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();

              /*
               * The previous attempt's failure goes first, whichever way this one
               * ends. `submit()` clears it on the path that reaches the API, and
               * the two client-side refusals below return before it — which left
               * "no stored webhook event has that id" sitting above a field error
               * about a *different* id the console had not sent anywhere.
               */
              clearError();

              const candidate = eventId.trim();

              if (candidate.length === 0) {
                setIdError(copy.idRequiredError);
                return;
              }

              // `IdSchema` is what the API validates the path parameter with, so
              // a value this accepts cannot come back as a malformed-id refusal —
              // and a paste that lost a character is caught here rather than as a
              // round trip.
              if (!IdSchema.safeParse(candidate).success) {
                setIdError(copy.idInvalidError);
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
                  <Field label={copy.idLabel} hint={copy.idHint} error={idError} isRequired>
                    {({ controlId, describedBy, isInvalid }) => (
                      <TextInput
                        id={controlId}
                        aria-describedby={describedBy}
                        aria-invalid={isInvalid}
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
                  pendingLabel={copy.pending}
                >
                  {copy.submit}
                </Button>
              </Cluster>
            </Stack>
          </form>
        </Stack>
      </SectionCard>

      {result === null ? null : <ReplayResult result={result} />}
    </Stack>
  );
}

/**
 * The last replay, as a report.
 *
 * `status` is always `received` on success and is shown anyway, because the
 * operator's next question is "will the sweeper pick it up" and this is the
 * field that answers it — together with `provider`, which decides *which*
 * sweeper, and only the WhatsApp one runs today.
 */
function ReplayResult({ result }: { result: AdminWebhookEventReplayResponse }) {
  const content = useContent();
  const copy = content.platformAdmin.webhookEvents;
  const isSwept = result.provider === 'whatsapp';

  const items: DetailListItem[] = [
    { id: 'id', term: copy.resultId, value: <code className={styles.id}>{result.id}</code> },
    { id: 'provider', term: copy.resultProvider, value: result.provider },
    {
      id: 'status',
      term: copy.resultStatus,
      value: <Badge tone="info">{content.platformAdmin.webhookStatuses[result.status]}</Badge>,
    },
    {
      id: 'parked-error',
      term: copy.resultParkedError,
      value: result.parkedError ?? copy.resultNoParkedError,
    },
    {
      id: 'replayed-at',
      term: copy.resultReplayedAt,
      value: <RelativeTime isoTimestamp={result.replayedAt} label={copy.resultReplayedAt} />,
    },
  ];

  return (
    <SectionCard id="webhook-replay-result" title={copy.resultHeading}>
      <Stack gap="4">
        <DetailList items={items} />
        {isSwept ? null : (
          // A fact about the platform rather than about the request, so it is
          // said beside the result rather than treated as a failure.
          <Notice tone="warning">{copy.providerNotSweptNotice}</Notice>
        )}
      </Stack>
    </SectionCard>
  );
}
