'use client';

import { useId } from 'react';
import type { AiConfigResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { formatModelPrice, modelOptions, resolvedModel } from '../presentation';
import styles from './AiConfigForm.module.css';

/**
 * Which model answers, with what it costs shown beside the choice. Usage:
 * `<ModelChoiceField config={config} value={model} onChange={setModel} disabled={…} />`.
 *
 * The price is rendered **where the decision is made** rather than in a help
 * page, because the models differ by 5× and a dropdown that hides that is a
 * dropdown that picks for you. It comes from `config.availableModels`, which the
 * API publishes: list prices change, and a console quoting a hard-coded number
 * would be telling a tenant something nobody owns.
 *
 * `''` is the empty choice and means `null` — "whatever the platform recommends
 * today" — so a tenant that never chooses is not pinned to whatever was current
 * the day their row was written. The caller maps it back.
 */
export function ModelChoiceField({
  config,
  value,
  onChange,
  isDisabled,
}: {
  config: AiConfigResponse;
  /** The stored value: a model id, or `''` for the platform default. */
  value: string;
  onChange: (value: string) => void;
  isDisabled: boolean;
}) {
  const content = useContent();
  const priceId = useId();
  const options = modelOptions(content, config);
  const chosen =
    value === ''
      ? resolvedModel(config)
      : config.availableModels.find((option) => option.id === value);

  return (
    <Field label={content.chatbot.modelLabel} hint={content.chatbot.modelHint}>
      {({ controlId, describedBy }) => (
        <>
          <Select
            id={controlId}
            // The price describes the option that is selected, so it is part of
            // the control's description rather than a line of text that happens
            // to sit under it — otherwise the one number that decides the choice
            // is the one thing a screen reader never reads out (TAR-710).
            aria-describedby={
              chosen === undefined
                ? describedBy
                : [describedBy, priceId].filter((id) => id !== undefined).join(' ')
            }
            name="model"
            value={value}
            disabled={isDisabled}
            options={options}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          {chosen === undefined ? null : (
            <p id={priceId} className={styles.price}>
              {content.chatbot.modelPrice(
                formatModelPrice(content.locale, chosen.inputPricePerMTokUsd),
                formatModelPrice(content.locale, chosen.outputPricePerMTokUsd),
              )}
            </p>
          )}
        </>
      )}
    </Field>
  );
}
