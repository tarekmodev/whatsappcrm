'use client';

import type { CSSProperties } from 'react';
import { AI_CONFIG_DEFAULTS } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Slider } from '@/components/ui/Slider';
import { useContent } from '@/lib/content';
import { MIN_CONFIDENCE_RANGE } from '../constants';
import { formatConfidence } from '../presentation';
import styles from './ConfidenceBand.module.css';

/** The percentages written under the band. Ends and quarters, and nothing else. */
const SCALE_STOPS = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * How sure the chatbot has to be before it answers instead of handing over —
 * drawn as what the threshold *does* rather than as how far along a rail it
 * sits. Usage: `<ConfidenceBand value={0.6} onChange={setValue} isDisabled />`.
 *
 * **The single highest-value visual on this page** (TAR-813). A bare slider
 * showing "60%" gives an admin no way to reason about the number: 60% of what,
 * and what happens on either side of it? The band answers both by labelling the
 * two regions the threshold creates — everything below hands to a person,
 * everything above the chatbot answers — with the knob sitting on the line
 * between them.
 *
 * **Still one control, and still the native range.** `Slider`'s `trackSlot`
 * repaints the rail; it does not replace the input. Arrows, Page Up/Down, Home
 * and End, the touch drag and the `aria-valuetext` sentence are all exactly what
 * they were. The two region labels are decoration and hidden from the
 * accessibility tree — announcing them would turn one value into three things to
 * listen to, and `aria-valuetext` ("60% sure") already says the judgement.
 *
 * **Nothing here is positioned with a physical transform**, so the band, its
 * scale and the default tick all mirror under `dir="rtl"` and zero stays at the
 * inline start — which is what keeps "Bot answers" the far end from zero in both
 * directions.
 */
export function ConfidenceBand({
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
        <div className={styles.band}>
          <Slider
            id={controlId}
            aria-describedby={describedBy}
            name="minConfidence"
            // The contract's own bounds, and a step coarse enough that a reader
            // can tell a number they chose from one a drag produced.
            min={MIN_CONFIDENCE_RANGE.min}
            max={MIN_CONFIDENCE_RANGE.max}
            step={MIN_CONFIDENCE_RANGE.step}
            value={value}
            disabled={isDisabled}
            // Promoted above the band: it is the value, and the two region
            // labels beside it are a picture of what the value means.
            layout="block"
            valueLabel={content.chatbot.confidenceValue(formatConfidence(content.locale, value))}
            trackSlot={
              <span className={styles.regions}>
                <span className={styles.handover}>
                  <span className={styles.regionLabel}>
                    {content.chatbot.confidenceHandoverRegion}
                  </span>
                </span>
                <span className={styles.answer}>
                  <span className={styles.regionLabel}>
                    {content.chatbot.confidenceAnswerRegion}
                  </span>
                </span>
              </span>
            }
            onChange={onChange}
          />

          {/*
            The scale and the tick are text, not positions — which is what keeps
            them readable in forced-colors mode, where the band's two fills
            disappear and only the words are left.
          */}
          <div className={styles.scale} aria-hidden="true">
            {SCALE_STOPS.map((stop) => (
              <span key={stop} className={styles.stop} style={stopStyle(stop)}>
                <span className={styles.stopText}>{formatConfidence(content.locale, stop)}</span>
              </span>
            ))}
            <span className={styles.tick} style={stopStyle(AI_CONFIG_DEFAULTS.minConfidence)}>
              <span className={styles.tickText}>{content.chatbot.confidenceDefaultTick}</span>
            </span>
          </div>

          {/*
            This caption earns its place. `compositeConfidence` is
            `min(model, retrieval)` by design, and an admin who reads it as an
            average tunes the threshold in the wrong direction.
          */}
          <p className={styles.caption}>{content.chatbot.confidenceCaption}</p>
        </div>
      )}
    </Field>
  );
}

/**
 * Where a mark sits along the band, in the knob's own coordinates.
 *
 * The same arithmetic `Slider`'s fill uses: the knob's centre travels from half
 * a knob in to half a knob short of the end, never from edge to edge, so a mark
 * placed at a flat percentage would drift away from the knob it is meant to
 * label — most visibly at the two ends, which is where the scale starts and
 * stops.
 */
function stopStyle(ratio: number): CSSProperties {
  return { '--stop-ratio': ratio } as CSSProperties;
}
