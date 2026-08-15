import type { OnboardingStepId, OnboardingStepStatus } from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';
import { routes } from '@/lib/routes';

/**
 * How the checklist's contract values are rendered. Pure lookups, so the
 * decisions are testable and every component reads the same answer.
 */

/**
 * Where each step's work actually happens. The checklist itself never edits
 * anything — it walks an admin to the surface that already owns the job, so a
 * step's content cannot drift from the settings page behind it.
 *
 * `null` means "no surface yet", and is not the same as "no link needed":
 * `set_branding` waits on TAR-29, and the step says so and offers the skip rather
 * than linking to a route that would 404.
 */
export const ONBOARDING_STEP_DESTINATIONS: Record<OnboardingStepId, string | null> = {
  connect_whatsapp: routes.settingsWhatsApp(),
  invite_agents: routes.settingsPeople(),
  set_branding: null,
};

/**
 * The badge each status wears. `skipped` is `info`, not `warning`: the admin made
 * a decision, and dressing it as a problem pressures them about something the
 * product told them was optional.
 */
export const ONBOARDING_STATUS_TONES: Record<OnboardingStepStatus, BadgeTone> = {
  pending: 'neutral',
  completed: 'success',
  skipped: 'info',
};

/**
 * Whether the step offers a "skip" or an "undo skip". A completed step offers
 * neither — there is nothing to put off, and the mock and the real API both
 * refuse the write.
 */
export function onboardingStepIntent(status: OnboardingStepStatus): 'skip' | 'reopen' | null {
  if (status === 'completed') {
    return null;
  }

  return status === 'skipped' ? 'reopen' : 'skip';
}
