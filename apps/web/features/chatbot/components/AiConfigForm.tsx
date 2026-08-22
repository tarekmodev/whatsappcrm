'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { AI_CONFIG_LIMITS, type AiConfigResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { Textarea } from '@/components/ui/Textarea';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateChatbotSettingsAction } from '../chatbot.actions';
import {
  formatKeywords,
  parseKeywords,
  validateSettings,
  type SettingsErrors,
} from '../entry-form';
import { ConfidenceField } from './ConfidenceField';
import { ModelChoiceField } from './ModelChoiceField';
import styles from './AiConfigForm.module.css';

/**
 * The chatbot's settings: whether it answers, which model it uses, how sure it
 * has to be, how long it may go on, and what it says when it gives up. Usage:
 * `<AiConfigForm config={config} canWrite />`.
 *
 * A real `<form>` with a real submit, and every control wired through `Field`
 * once, so none of them can be shipped without a label and an error slot.
 *
 * **The switch is `Answer customers automatically`, not `Enabled`**, and it is
 * first. It is the only control here that changes what a customer experiences,
 * and an admin turning the chatbot off in a hurry should not have to read four
 * other labels to find it.
 *
 * `canWrite` comes from the server's permission check and only decides whether
 * the controls are interactive: the server action asserts `ai:write` again and
 * the API a third time. A principal who may read but not write gets the values
 * as disabled controls with a notice above them — hiding the settings would
 * leave them unable to see what the chatbot is doing at all.
 */
export function AiConfigForm({
  config,
  canWrite,
}: {
  config: AiConfigResponse;
  canWrite: boolean;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [isEnabled, setIsEnabled] = useState(config.isEnabled);
  const [model, setModel] = useState(config.model ?? '');
  const [minConfidence, setMinConfidence] = useState(config.minConfidence);
  const [maxBotTurns, setMaxBotTurns] = useState(String(config.maxBotTurns));
  const [systemPrompt, setSystemPrompt] = useState(config.systemPrompt ?? '');
  const [handoffMessage, setHandoffMessage] = useState(config.handoffMessage ?? '');
  const [keywordText, setKeywordText] = useState(formatKeywords(config.handoffKeywords));
  const [fieldErrors, setFieldErrors] = useState<SettingsErrors>({});
  const maxBotTurnsRef = useRef<HTMLInputElement>(null);
  const handoffKeywordsRef = useRef<HTMLTextAreaElement>(null);

  const perform = useCallback(async () => {
    return updateChatbotSettingsAction({
      isEnabled,
      // `''` is the empty choice, and the contract spells "the platform
      // default" `null`. Sending the empty string would fail its enum and read
      // to the user as a bug rather than as a choice they made.
      model: model === '' ? null : model,
      minConfidence,
      maxBotTurns: Number(maxBotTurns),
      systemPrompt: systemPrompt.trim() === '' ? null : systemPrompt.trim(),
      handoffMessage: handoffMessage.trim() === '' ? null : handoffMessage.trim(),
      handoffKeywords: parseKeywords(keywordText),
    });
  }, [handoffMessage, isEnabled, keywordText, maxBotTurns, minConfidence, model, systemPrompt]);

  const onSuccess = useCallback(() => {
    // Nothing is cleared and nothing is re-seeded from the response: the values
    // on screen are the ones just saved, and the server re-renders the page
    // behind this anyway.
    showToast({ tone: 'success', message: content.chatbot.settingsSavedToast });
  }, [content, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });
  const isDisabled = !canWrite;

  return (
    <form
      className={styles.form}
      // Validated here rather than by the browser, so the two fields with rules
      // report them through `Field` like every other error in the console
      // instead of in a native bubble that no theme reaches and no test can read.
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const errors = validateSettings({
          keywords: parseKeywords(keywordText),
          maxBotTurns,
        });

        setFieldErrors(errors);

        if (Object.keys(errors).length > 0) {
          // The cursor goes to the first field that is wrong, in the order they
          // appear: an error message below a control somebody has scrolled past
          // is an error message nobody reads.
          const firstInvalid =
            errors.maxBotTurns === undefined ? handoffKeywordsRef.current : maxBotTurnsRef.current;

          firstInvalid?.focus();

          return;
        }

        submit();
      }}
    >
      <Stack gap="4">
        {canWrite ? null : <Notice tone="info">{content.chatbot.settingsReadOnlyNotice}</Notice>}

        <Field label={content.chatbot.enabledLabel} hint={content.chatbot.enabledHint}>
          {({ controlId, describedBy }) => (
            <Cluster gap="3" align="center">
              <input
                id={controlId}
                aria-describedby={describedBy}
                className={styles.switch}
                type="checkbox"
                name="isEnabled"
                checked={isEnabled}
                disabled={isDisabled}
                onChange={(event) => {
                  setIsEnabled(event.target.checked);
                }}
              />
              {/* The state in words beside the control: a checkbox's own state
                  is conveyed to a screen reader, but not to somebody reading
                  the page in forced-colors mode where the tick may not show. */}
              <span className={styles.switchState}>
                {isEnabled ? content.chatbot.enabledOn : content.chatbot.enabledOff}
              </span>
            </Cluster>
          )}
        </Field>

        <ModelChoiceField
          config={config}
          value={model}
          onChange={setModel}
          isDisabled={isDisabled}
        />

        <ConfidenceField
          value={minConfidence}
          onChange={setMinConfidence}
          isDisabled={isDisabled}
        />

        <Field
          label={content.chatbot.maxTurnsLabel}
          hint={content.chatbot.maxTurnsHint}
          error={fieldErrors.maxBotTurns}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              ref={maxBotTurnsRef}
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              className={styles.number}
              type="number"
              inputMode="numeric"
              name="maxBotTurns"
              min={AI_CONFIG_LIMITS.minBotTurns}
              max={AI_CONFIG_LIMITS.maxBotTurns}
              step={1}
              value={maxBotTurns}
              disabled={isDisabled}
              onChange={(event) => {
                setMaxBotTurns(event.target.value);
                setFieldErrors({});
              }}
            />
          )}
        </Field>

        <Field
          label={content.chatbot.handoffKeywordsLabel}
          hint={content.chatbot.handoffKeywordsHint}
          error={fieldErrors.handoffKeywords}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <Textarea
              ref={handoffKeywordsRef}
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              name="handoffKeywords"
              rows={4}
              placeholder={content.chatbot.handoffKeywordsPlaceholder}
              value={keywordText}
              disabled={isDisabled}
              onChange={(event) => {
                setKeywordText(event.target.value);
                setFieldErrors({});
              }}
            />
          )}
        </Field>

        <Field label={content.chatbot.systemPromptLabel} hint={content.chatbot.systemPromptHint}>
          {({ controlId, describedBy }) => (
            <Textarea
              id={controlId}
              aria-describedby={describedBy}
              name="systemPrompt"
              rows={4}
              maxLength={AI_CONFIG_LIMITS.systemPromptLength}
              value={systemPrompt}
              disabled={isDisabled}
              onChange={(event) => {
                setSystemPrompt(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          label={content.chatbot.handoffMessageLabel}
          hint={content.chatbot.handoffMessageHint}
        >
          {({ controlId, describedBy }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              name="handoffMessage"
              maxLength={AI_CONFIG_LIMITS.handoffMessageLength}
              value={handoffMessage}
              disabled={isDisabled}
              onChange={(event) => {
                setHandoffMessage(event.target.value);
              }}
            />
          )}
        </Field>

        <FormError message={formError} requestId={requestId} />

        {canWrite ? (
          <Cluster justify="end">
            <Button type="submit" variant="primary" isPending={isPending}>
              {content.chatbot.saveSettings}
            </Button>
          </Cluster>
        ) : null}
      </Stack>
    </form>
  );
}
