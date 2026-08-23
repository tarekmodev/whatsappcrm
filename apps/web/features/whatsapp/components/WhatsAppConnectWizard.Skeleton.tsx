import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonForText } from '@/components/ui/Skeleton';
import { Stepper, StepperStep } from '@/components/ui/Stepper';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { WHATSAPP_WIZARD_STEP_IDS } from '../wizard';
import styles from './WhatsAppWizardStep.module.css';

/**
 * Mirrors `WhatsAppConnectWizard` as an admin who has connected nothing will see
 * it: an empty meter, four steps with their real titles, and the first one open
 * on its intro and its button.
 *
 * Almost nothing here is a guess. Every step's title and summary is copy, known
 * long before any data is, so the only thing that moves when the wizard arrives
 * is a status chip and — for somebody resuming — the markers. That is what keeps
 * the lazy boundary from changing the card's height as it hands over.
 *
 * Both placeholders are measured from the real copy rather than given a width:
 * the intro wraps to three lines on a phone and one on a laptop, and the button
 * is as wide as its label, so a guessed width would be wrong at some viewport.
 * `SkeletonForText` renders the string invisibly and shimmers over the box it
 * occupies, which is the same box the real text takes.
 *
 * Changed in the same commit as the wizard it stands in for. A skeleton that has
 * drifted is a bug, not a cosmetic issue.
 */
export function WhatsAppConnectWizardSkeleton() {
  const content = useContent();
  const copy = content.whatsapp.wizard;
  const total = WHATSAPP_WIZARD_STEP_IDS.length;

  return (
    <Stack gap="4">
      <LoadingAnnouncement label={content.whatsapp.loading} />
      <Stepper
        label={copy.progressLabel}
        resolved={0}
        total={total}
        progressLabel={copy.progressCount(0, total)}
      >
        {WHATSAPP_WIZARD_STEP_IDS.map((stepId, index) => (
          <StepperStep
            key={stepId}
            position={index + 1}
            // The first step open and the rest upcoming: the state a workspace
            // with nothing connected lands in, which is the common case for a
            // page somebody is waiting on.
            status={index === 0 ? 'current' : 'upcoming'}
            title={copy.steps[stepId].title}
            statusLabel={copy.statuses[index === 0 ? 'current' : 'upcoming']}
            summary={copy.steps[stepId].upcoming}
          >
            <Stack gap="4">
              <p className={styles.intro}>
                <SkeletonForText>{content.whatsapp.connectIntro}</SkeletonForText>
              </p>
              <div className={styles.actions}>
                <span aria-hidden="true" className={styles.actionPlaceholder}>
                  <SkeletonForText>{content.whatsapp.connectButton}</SkeletonForText>
                </span>
              </div>
            </Stack>
          </StepperStep>
        ))}
      </Stepper>
    </Stack>
  );
}
