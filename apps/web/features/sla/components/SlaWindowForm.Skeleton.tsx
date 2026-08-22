'use client';

import { SLA_DEFAULTS } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import {
  SettingsForm,
  SettingsFormActions,
  SettingsFormSection,
} from '@/components/ui/SettingsForm';
import { SkeletonBlock, SkeletonForText } from '@/components/ui/Skeleton';
import { formatMinutes } from '@/lib/format/duration';
import { useContent } from '@/lib/content';
import styles from './SlaWindowForm.module.css';

/**
 * Mirrors `SlaWindowForm` — the same `SettingsForm`, the same section, the same
 * three `Field`s with the same labels and hints in the same order, and the same
 * trailing action row — so the lazy boundary hands over without the card
 * changing height, at either layout.
 *
 * The labels and hints are real strings, because they are copy the skeleton
 * already knows; only the values and the button are placeholders. Each control
 * is a `SkeletonBlock` at the height its real control occupies — a touch target
 * for the switch, a control height for the two inputs — which is what makes the
 * swap produce no shift.
 *
 * `'use client'`, and it has to be: it renders through the real `Field` and the
 * real `SettingsForm`, whose render-prop children are a function, and a function
 * cannot cross the server-to-client boundary. The same trade
 * `AiConfigForm.Skeleton` makes, for the same reason — rendering the real layout
 * is what stops this drifting when its spacing changes.
 *
 * Changed in the same commit as the form it stands in for.
 */
export function SlaWindowFormSkeleton() {
  const content = useContent();
  const copy = content.slaSettings;

  return (
    <SettingsForm as="div">
      <LoadingAnnouncement label={copy.loading} />

      <SettingsFormSection>
        <Field label={copy.activeLabel} hint={copy.activeHint}>
          {() => (
            <SkeletonBlock
              className={styles.togglePlaceholder}
              height="var(--size-touch-target)"
            />
          )}
        </Field>
        <Field
          label={copy.firstResponseLabel}
          hint={copy.firstResponseHint(formatMinutes(SLA_DEFAULTS.firstResponseMinutes, content))}
        >
          {() => <SkeletonBlock className={styles.window} height="var(--size-control-md)" />}
        </Field>
        <Field label={copy.resolutionLabel} hint={copy.resolutionHint}>
          {() => <SkeletonBlock className={styles.window} height="var(--size-control-md)" />}
        </Field>
      </SettingsFormSection>

      <SettingsFormActions>
        <span aria-hidden="true" className={styles.actionPlaceholder}>
          <SkeletonForText>{copy.save}</SkeletonForText>
        </span>
      </SettingsFormActions>
    </SettingsForm>
  );
}
