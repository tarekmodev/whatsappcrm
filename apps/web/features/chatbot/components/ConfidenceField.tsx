'use client';

import { Field } from '@/components/ui/Field';
import { Slider } from '@/components/ui/Slider';
import { useContent } from '@/lib/content';
import { MIN_CONFIDENCE_RANGE } from '../constants';
import { formatConfidence } from '../presentation';

/**
 * How sure the chatbot has to be before it answers instead of handing over.
 * Usage: `<ConfidenceField value={0.6} onChange={setValue} isDisabled={false} />`.
 *
 * `Slider`, which is the native range with this app's face on it: the keyboard
 * model — arrows, Page Up/Down, Home and End — and the touch behaviour are the
 * platform's, and only the painting is ours (TAR-710).
 *
 * The live value is a percentage rather than `0.6`, and it is a **sentence**
 * rather than a number: the same "60% sure" is the `<output>` beside the control
 * and its `aria-valuetext`, so a screen reader hears the judgement an admin is
 * making on every arrow press rather than a bare figure.
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
        <Slider
          id={controlId}
          aria-describedby={describedBy}
          name="minConfidence"
          min={MIN_CONFIDENCE_RANGE.min}
          max={MIN_CONFIDENCE_RANGE.max}
          step={MIN_CONFIDENCE_RANGE.step}
          value={value}
          disabled={isDisabled}
          valueLabel={content.chatbot.confidenceValue(formatConfidence(content.locale, value))}
          onChange={onChange}
        />
      )}
    </Field>
  );
}
