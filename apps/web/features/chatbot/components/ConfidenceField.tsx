'use client';

import { Field } from '@/components/ui/Field';
import { useContent } from '@/lib/content';
import { MIN_CONFIDENCE_RANGE } from '../constants';
import { formatConfidence } from '../presentation';
import styles from './AiConfigForm.module.css';

/**
 * How sure the chatbot has to be before it answers instead of handing over.
 * Usage: `<ConfidenceField value={0.6} onChange={setValue} isDisabled={false} />`.
 *
 * A native `range`, which is keyboard-operable and screen-reader-labelled by
 * construction and opens no custom widget on touch. The live value is rendered
 * beside it as a percentage rather than as `0.6`: the number is a judgement an
 * admin makes — "how sure is sure enough" — and two decimal places read as
 * something somebody else calibrated.
 *
 * The bounds and the step come from `MIN_CONFIDENCE_RANGE` rather than being
 * typed here, so the control cannot offer a value the contract's schema refuses,
 * and cannot produce 0.6173.
 */
export function ConfidenceField({
  value,
  onChange,
  isDisabled,
}: {
  value: number;
  onChange: (value: number) => void;
  isDisabled: boolean;
}) {
  const content = useContent();

  return (
    <Field label={content.chatbot.confidenceLabel} hint={content.chatbot.confidenceHint}>
      {({ controlId, describedBy }) => (
        <div className={styles.slider}>
          <input
            id={controlId}
            aria-describedby={describedBy}
            className={styles.range}
            type="range"
            name="minConfidence"
            min={MIN_CONFIDENCE_RANGE.min}
            max={MIN_CONFIDENCE_RANGE.max}
            step={MIN_CONFIDENCE_RANGE.step}
            value={value}
            disabled={isDisabled}
            // The percentage, not the raw `0.6`: `aria-valuenow` is what a
            // screen reader reads out on every arrow press.
            aria-valuetext={formatConfidence(content.locale, value)}
            onChange={(event) => {
              onChange(Number(event.target.value));
            }}
          />
          {/* Not `aria-live`: the input already announces its own value on
              change, and a live region would say it a second time. */}
          <output className={styles.sliderValue} htmlFor={controlId}>
            {content.chatbot.confidenceValue(formatConfidence(content.locale, value))}
          </output>
        </div>
      )}
    </Field>
  );
}
