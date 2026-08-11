'use client';

import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  renderTemplateBody,
  type MessageTemplateResponse,
  type SendTemplateInput,
} from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { sendMessageAction } from '@/features/inbox/composer.actions';
import { useIdempotencyKey } from '@/features/inbox/useIdempotencyKey';
import {
  buildTemplateSend,
  emptyTemplateDraft,
  type TemplateDraftProblem,
  type TemplateLocationDraft,
} from '@/features/inbox/template-draft';
import { EMPTY_ATTACHMENT, type ComposerAttachmentValue } from '@/features/inbox/media-draft';
import { TemplateHeaderFields } from './TemplateHeaderFields';
import { TemplateVariableFields } from './TemplateVariableFields';
import styles from './TemplatePicker.module.css';

/**
 * The chosen template, filled in and sent. Usage:
 * `<TemplateSendForm conversationId={id} template={…} onSent={…} onBack={…} />`.
 *
 * ## The preview is the contract's renderer, not a second one
 *
 * What the agent reads before pressing Send is produced by the same
 * `renderTemplateBody` the API stores on the message row afterwards. A local
 * copy of that substitution would be a screen promising one sentence while the
 * customer received another — the one thing a record of a conversation must
 * never do.
 *
 * ## Every refusal is decided before the send
 *
 * Arity and header rules are checked by `buildTemplateSend`, so a draft that
 * Meta cannot render never reaches the API. The Send button stays live and the
 * reason appears beside it: a disabled button that explains nothing is the
 * hardest kind of thing to diagnose from the other end of a support call.
 */

export interface TemplateSendFormProps {
  conversationId: string;
  template: MessageTemplateResponse;
  onSent: () => void;
  onBack: () => void;
}

export function TemplateSendForm({
  conversationId,
  template,
  onSent,
  onBack,
}: TemplateSendFormProps) {
  const content = useContent();
  const { keyFor, retire } = useIdempotencyKey();
  const initial = useMemo(() => emptyTemplateDraft(template), [template]);
  const [variables, setVariables] = useState<readonly string[]>(initial.variables);
  const [headerVariables, setHeaderVariables] = useState<readonly string[]>(
    initial.headerVariables,
  );
  const [location, setLocation] = useState<TemplateLocationDraft>(initial.location);
  const [headerMedia, setHeaderMedia] = useState<ComposerAttachmentValue>(EMPTY_ATTACHMENT);
  const [problem, setProblem] = useState<TemplateDraftProblem | null>(null);
  const pendingRef = useRef<SendTemplateInput | null>(null);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: () => {
      const input = pendingRef.current;

      if (input === null) {
        return Promise.resolve({
          status: 'error' as const,
          message: content.form.genericSubmitError,
          requestId: null,
        });
      }

      return sendMessageAction(conversationId, keyFor(JSON.stringify(input)), input);
    },
    onSuccess: useCallback(() => {
      // Closing the dialog unmounts this form and takes the key with it, so
      // today this is belt and braces. It is here anyway because "the key that
      // sent a message is retired" should be a property of the send, not of
      // whether a parent happens to unmount afterwards.
      retire();
      onSent();
    }, [onSent, retire]),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const build = buildTemplateSend(template, {
      variables,
      headerVariables,
      location,
      headerMedia,
    });

    if (build.outcome === 'incomplete') {
      setProblem(build.problem);
      return;
    }

    setProblem(null);
    pendingRef.current = build.input;
    submit();
  };

  const preview = renderTemplateBody(template.bodyText, variables);
  // Assigning the content object to the exhaustive record is the check: a new
  // `TemplateDraftProblem` without a line of copy fails the build here rather
  // than rendering `undefined` at somebody.
  const problemMessages: Record<TemplateDraftProblem, string> = content.composer.templateProblems;

  return (
    <form onSubmit={onSubmit} noValidate>
      <Stack gap="4">
        <Cluster justify="between" align="start" gap="3">
          <Stack gap="1">
            <strong className={styles.name}>{template.name}</strong>
            <span className={styles.language}>
              {content.composer.templateLanguage(template.language)}
            </span>
          </Stack>
          <Button variant="ghost" size="sm" onClick={onBack}>
            {content.composer.templateBack}
          </Button>
        </Cluster>

        <TemplateHeaderFields
          format={template.headerFormat}
          draft={{ variables, headerVariables, location, headerMedia }}
          onHeaderVariablesChange={setHeaderVariables}
          onHeaderMediaChange={setHeaderMedia}
          onLocationChange={setLocation}
          isDisabled={isPending}
        />

        <TemplateVariableFields
          values={variables}
          label={content.composer.templateVariableLabel}
          onChange={setVariables}
          isDisabled={isPending}
        />

        <Stack gap="1">
          <strong className={styles.previewHeading}>
            {content.composer.templatePreviewHeading}
          </strong>
          <p className={styles.preview}>{preview ?? content.composer.templateNoPreview}</p>
        </Stack>

        {problem === null ? null : <Notice tone="warning">{problemMessages[problem]}</Notice>}

        <FormError message={formError} requestId={requestId} />

        <Cluster justify="end" gap="2">
          {/* Disabled while a header upload runs, mirroring the free-form
              composer: a Send that can only refuse is not one to offer. */}
          <Button
            type="submit"
            variant="primary"
            disabled={headerMedia.status === 'uploading'}
            isPending={isPending}
          >
            {content.composer.templateSend}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
