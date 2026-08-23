'use client';

import { useCallback, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AI_CONFIG_LIMITS, type AiConfigResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SettingsForm, SettingsFormSection } from '@/components/ui/SettingsForm';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { Switch } from '@/components/ui/Switch';
import { Textarea } from '@/components/ui/Textarea';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateChatbotSettingsAction } from '../chatbot.actions';
import { CHATBOT_SECTION_IDS } from '../constants';
import { parseKeywords, validateSettings, type SettingsErrors } from '../entry-form';
import { draftChangeCount, draftInput, settingsDraft, type SettingsDraft } from '../settings-draft';
import { CharacterCount } from './CharacterCount';
import { ConfidenceBand } from './ConfidenceBand';
import { HandoffKeywordChips } from './HandoffKeywordChips';
import { HandoffMessagePreview } from './HandoffMessagePreview';
import { ModelChoiceField } from './ModelChoiceField';
import { Rule, RuleLadder } from './RuleLadder';
import { StickySaveBar } from './StickySaveBar';
import styles from './ChatbotSettingsForm.module.css';

/**
 * Stages B, C and D of the chatbot surface: when it may answer, how sure it has
 * to be, and what it says. Usage:
 * `<ChatbotSettingsForm config={config} canWrite isInPlan />`.
 *
 * Three cards inside one `<form>`, because they are three ideas and one
 * resource. `PATCH /ai/config` takes all of it; splitting the commit per card
 * would be three round trips and three ways to fail for one endpoint (TAR-813).
 *
 * ## Two commit behaviours, and mixing them up is how this ships wrong
 *
 * **The master switch commits on flip**, on its own, carrying `isEnabled` alone
 * — legal today, because `UpdateAiConfigInput` is `.partial()`. This is a change
 * from the form it replaces, and it is deliberate: it is the only control here
 * whose lag has a live customer consequence, and a switch reading *off* while
 * the bot is still answering is the one wrong state on this page that costs
 * somebody a conversation. Optimistic, with a rollback and an inline notice on
 * failure — a toast would slide away and leave the switch lying.
 *
 * **Everything else is one form, one submit**, from the sticky bar. Its state
 * survives a re-render of the server component above it, which is why an admin's
 * half-written system prompt is not thrown away when a search runs in the card
 * below (the boundary is unkeyed for the same reason — see `page.tsx`).
 *
 * Nothing a source does ever reaches either. Adding, editing, re-indexing and
 * deleting all write immediately from their own dialogs, and the save bar must
 * never appear because one of them happened.
 *
 * `canWrite` comes from the server's permission check and only decides whether
 * the controls are interactive: the server action asserts `ai:write` again and
 * the API a third time. A principal who may read but not write gets the values
 * as disabled controls with a notice above them — hiding the settings would
 * leave them unable to see what the chatbot is doing at all.
 */
export function ChatbotSettingsForm({
  config,
  canWrite,
  isInPlan,
}: {
  config: AiConfigResponse;
  canWrite: boolean;
  isInPlan: boolean;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const systemPromptCountId = useId();
  const handoffMessageCountId = useId();

  const initial = useMemo(() => settingsDraft(config), [config]);
  // `saved` is what the last successful write left on the server, and it is the
  // only thing "unsaved" is measured against. Seeded once and moved on success:
  // re-seeding it from `config` on every render would erase the difference the
  // moment the page revalidated behind an open edit.
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<SettingsErrors>({});
  const maxBotTurnsRef = useRef<HTMLInputElement>(null);
  const handoffKeywordsRef = useRef<HTMLTextAreaElement>(null);

  const isDisabled = !canWrite;
  const keywords = useMemo(() => parseKeywords(draft.keywordText), [draft.keywordText]);
  const changeCount = draftChangeCount(draft, saved);

  const update = useCallback((patch: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // Any edit clears the last validation pass: an error message describing a
    // value that has since been retyped is worse than no message at all.
    setFieldErrors({});
  }, []);

  const perform = useCallback(async () => updateChatbotSettingsAction(draftInput(draft)), [draft]);

  const onSuccess = useCallback(() => {
    // The values on screen are the ones just saved, so nothing is re-seeded from
    // the response; what moves is the mark they are measured against, which is
    // what puts the save bar away.
    setSaved(draft);
    showToast({ tone: 'success', message: content.chatbot.settingsSavedToast });
  }, [content, draft, showToast]);

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform,
    onSuccess,
  });

  const { isEnabled, isEnabledPending, enabledError, setEnabled } = useMasterSwitch(config);

  return (
    <SettingsForm
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const errors = validateSettings({ keywords, maxBotTurns: draft.maxBotTurns });

        setFieldErrors(errors);

        if (Object.keys(errors).length > 0) {
          // The cursor goes to the first field that is wrong, in the order they
          // appear: an error below a control somebody has scrolled past is an
          // error nobody reads — and from a bar pinned to the bottom of the
          // viewport, everything is scrolled past.
          const firstInvalid =
            errors.maxBotTurns === undefined ? handoffKeywordsRef.current : maxBotTurnsRef.current;

          firstInvalid?.focus();

          return;
        }

        submit();
      }}
    >
      {/* ---- Stage B · When it may answer ---------------------------------- */}
      <SectionCard
        id={CHATBOT_SECTION_IDS.eligibility}
        title={content.chatbot.eligibilityHeading}
        description={content.chatbot.eligibilityDescription}
      >
        <Stack gap="4">
          {isInPlan ? null : <Notice tone="warning">{content.chatbot.upsellNotice}</Notice>}
          {canWrite ? null : <Notice tone="info">{content.chatbot.settingsReadOnlyNotice}</Notice>}
          {/* The switch's own failure, inside the stage it belongs to and not in
              the save bar: the bar speaks for the form, and this did not go
              through it. It stays until the next attempt — the state on screen
              and the state on the server disagreed, and that has to keep saying
              so. */}
          {enabledError === null ? null : <Notice tone="danger">{enabledError}</Notice>}

          <RuleLadder label={content.chatbot.ruleLadderLabel}>
            <Rule>
              <Field
                label={content.chatbot.ruleEnabledName}
                hint={content.chatbot.ruleEnabledClause}
              >
                {({ controlId, describedBy }) => (
                  <Switch
                    id={controlId}
                    aria-describedby={describedBy}
                    name="isEnabled"
                    isChecked={isEnabled}
                    // Only while its own write is in flight. Optimistic state
                    // plus a second flip mid-request is two requests racing to
                    // decide whether customers are being answered.
                    disabled={isDisabled || isEnabledPending}
                    stateLabel={isEnabled ? content.chatbot.enabledOn : content.chatbot.enabledOff}
                    onChange={setEnabled}
                  />
                )}
              </Field>
            </Rule>

            {/* A real gate with nothing to set. On the ladder precisely because
                it is not configurable: `agent_requested` is why the bot goes
                quiet mid-conversation, and an admin debugging that needs to see
                it rather than deduce it from the inbox. */}
            <Rule isConfigurable={false}>
              <Field label={content.chatbot.ruleThreadName} hint={content.chatbot.ruleThreadClause}>
                {({ controlId }) => (
                  <StaticFieldValue id={controlId}>
                    {content.chatbot.ruleThreadNote}
                  </StaticFieldValue>
                )}
              </Field>
            </Rule>

            <Rule>
              <Field
                label={content.chatbot.ruleTurnsName}
                hint={turnsClause(content, draft.maxBotTurns)}
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
                    value={draft.maxBotTurns}
                    disabled={isDisabled}
                    onChange={(event) => {
                      update({ maxBotTurns: event.target.value });
                    }}
                  />
                )}
              </Field>
            </Rule>

            <Rule>
              <Field
                label={content.chatbot.ruleKeywordsName}
                hint={
                  keywords.length === 0
                    ? content.chatbot.ruleKeywordsClauseEmpty
                    : content.chatbot.ruleKeywordsClause(keywords.length)
                }
                error={fieldErrors.handoffKeywords}
              >
                {({ controlId, describedBy, isInvalid }) => (
                  <>
                    <Textarea
                      ref={handoffKeywordsRef}
                      id={controlId}
                      aria-describedby={describedBy}
                      aria-invalid={isInvalid}
                      name="handoffKeywords"
                      rows={4}
                      placeholder={content.chatbot.handoffKeywordsPlaceholder}
                      value={draft.keywordText}
                      disabled={isDisabled}
                      onChange={(event) => {
                        update({ keywordText: event.target.value });
                      }}
                    />
                    {/* Only when there is a parse to show. The empty case is
                        already the rule's own sentence above, and saying it
                        twice under one label reads as two different facts. */}
                    {keywords.length === 0 ? null : (
                      <HandoffKeywordChips
                        keywords={keywords}
                        isDisabled={isDisabled}
                        onChange={(keywordText) => {
                          update({ keywordText });
                        }}
                      />
                    )}
                  </>
                )}
              </Field>
            </Rule>
          </RuleLadder>
        </Stack>
      </SectionCard>

      {/* ---- Stage C · How sure it has to be -------------------------------- */}
      <SectionCard
        id={CHATBOT_SECTION_IDS.confidence}
        title={content.chatbot.confidenceHeading}
        description={content.chatbot.confidenceDescription}
      >
        <ConfidenceBand
          value={draft.minConfidence}
          isDisabled={isDisabled}
          onChange={(minConfidence) => {
            update({ minConfidence });
          }}
        />
      </SectionCard>

      {/* ---- Stage D · What it says ----------------------------------------- */}
      <SectionCard
        id={CHATBOT_SECTION_IDS.handoff}
        title={content.chatbot.handoffHeading}
        description={content.chatbot.handoffDescription}
      >
        <SettingsFormSection>
          {/* The model is here rather than in a stage of its own: with the
              prompt, it is what decides the wording of a reply. TAR-810's spec
              named four stages and no home for it — flagged on that issue. */}
          <ModelChoiceField
            config={config}
            value={draft.model}
            isDisabled={isDisabled}
            onChange={(model) => {
              update({ model });
            }}
          />

          <Field label={content.chatbot.systemPromptLabel} hint={content.chatbot.systemPromptHint}>
            {({ controlId, describedBy }) => (
              <>
                <Textarea
                  id={controlId}
                  // The room left is part of what describes the field, not a
                  // line of text that happens to sit under it — otherwise the
                  // one number that says whether it will save is the one thing
                  // a screen reader never reads out.
                  aria-describedby={describedWith(describedBy, systemPromptCountId)}
                  name="systemPrompt"
                  rows={4}
                  maxLength={AI_CONFIG_LIMITS.systemPromptLength}
                  value={draft.systemPrompt}
                  disabled={isDisabled}
                  onChange={(event) => {
                    update({ systemPrompt: event.target.value });
                  }}
                />
                <CharacterCount
                  id={systemPromptCountId}
                  length={draft.systemPrompt.length}
                  limit={AI_CONFIG_LIMITS.systemPromptLength}
                />
              </>
            )}
          </Field>

          <Field
            label={content.chatbot.handoffMessageLabel}
            hint={content.chatbot.handoffMessageHint}
          >
            {({ controlId, describedBy }) => (
              <>
                <TextInput
                  id={controlId}
                  aria-describedby={describedWith(describedBy, handoffMessageCountId)}
                  name="handoffMessage"
                  maxLength={AI_CONFIG_LIMITS.handoffMessageLength}
                  value={draft.handoffMessage}
                  disabled={isDisabled}
                  onChange={(event) => {
                    update({ handoffMessage: event.target.value });
                  }}
                />
                <CharacterCount
                  id={handoffMessageCountId}
                  length={draft.handoffMessage.length}
                  limit={AI_CONFIG_LIMITS.handoffMessageLength}
                />
                <HandoffMessagePreview message={draft.handoffMessage} />
              </>
            )}
          </Field>
        </SettingsFormSection>
      </SectionCard>

      {/* Last in the DOM, so it is last in the focus order — a bar pinned over
          the form must not be the first thing Tab reaches from the top of it. */}
      {canWrite && changeCount > 0 ? (
        <StickySaveBar
          changeCount={changeCount}
          isPending={isPending}
          formError={formError}
          requestId={requestId}
          onCancel={() => {
            setDraft(saved);
            setFieldErrors({});
            clearError();
          }}
        />
      ) : null}
    </SettingsForm>
  );
}

/**
 * The one control that writes on its own.
 *
 * Optimistic and rolled back rather than pending-then-settled: 0001 rules that a
 * switch "reads as the mode the product is in right now", and a control that
 * lags a round trip behind the mode is a control that lies for as long as the
 * network takes. What it must never do is lie *afterwards* — hence the rollback
 * and the message, both of which stay until the next attempt.
 *
 * `inFlightRef` rather than the pending state, for the same reason
 * `useActionForm` keeps one: two flips in the same tick would both read
 * `isEnabledPending === false`.
 */
function useMasterSwitch(config: AiConfigResponse) {
  const content = useContent();
  const [isEnabled, setIsEnabled] = useState(config.isEnabled);
  const [isEnabledPending, setIsEnabledPending] = useState(false);
  const [enabledError, setEnabledError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const setEnabled = useCallback(
    (next: boolean) => {
      if (inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;
      setIsEnabled(next);
      setEnabledError(null);
      setIsEnabledPending(true);

      void updateChatbotSettingsAction({ isEnabled: next })
        .then((result) => {
          if (result.status === 'success') {
            return;
          }

          setIsEnabled(!next);
          // The server's own reason where there is one — "not on this plan"
          // sends somebody somewhere useful, and the generic line does not.
          setEnabledError(result.message);
        })
        .catch((error: unknown) => {
          // Only reached if the action failed to run at all — a dropped
          // connection, a chunk that would not load. Not swallowed.
          console.error('Chatbot master switch failed', error);
          setIsEnabled(!next);
          setEnabledError(content.chatbot.enabledSaveFailed);
        })
        .finally(() => {
          inFlightRef.current = false;
          setIsEnabledPending(false);
        });
    },
    [content],
  );

  return { isEnabled, isEnabledPending, enabledError, setEnabled };
}

/** The reply-limit rule's sentence, or a nudge when the box holds no limit yet. */
function turnsClause(content: ReturnType<typeof useContent>, maxBotTurns: string): string {
  const parsed = Number(maxBotTurns.trim());

  return maxBotTurns.trim() === '' || !Number.isInteger(parsed)
    ? content.chatbot.ruleTurnsClauseUnset
    : content.chatbot.ruleTurnsClause(parsed);
}

/** Adds an id to whatever `Field` already published, without ever writing `undefined`. */
function describedWith(describedBy: string | undefined, id: string): string {
  return [describedBy, id].filter((value) => value !== undefined).join(' ');
}
