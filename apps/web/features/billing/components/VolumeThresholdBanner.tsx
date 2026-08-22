import { AlertBanner } from '@/components/ui/AlertBanner';
import { TextLink } from '@/components/ui/TextLink';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { formatCount, readVolumeBanner, type PlanUsageReadings } from '../plan-presentation';

/**
 * The conversation-allowance warning. Usage:
 * `<VolumeThresholdBanner readings={readings} withAction />` — renders nothing
 * below the threshold, so the caller needs no conditional of its own.
 *
 * TAR-37's acceptance criterion is that a tenant admin is *told* when the volume
 * threshold is crossed. The API sends a notification once per period; this is the
 * standing version of the same message, on the surfaces where somebody can act on
 * it.
 *
 * **Neither state claims anything was blocked.** The platform's default volume
 * policy is `warn`, and inbound is never refused under either policy — a
 * customer's message is always accepted and stored. A banner that said "your
 * replies are blocked" on a `warn` deployment would be false, and frightening in
 * exactly the way that gets a reseller a support call.
 *
 * `withAction` is off where the banner is already on the billing page: a "compare
 * plans" link to the page you are reading is noise.
 */
export function VolumeThresholdBanner({
  readings,
  withAction = false,
}: {
  readings: PlanUsageReadings;
  withAction?: boolean;
}) {
  const content = useContent();
  const level = readVolumeBanner(readings);

  if (level === null) {
    return null;
  }

  const { used, cap } = readings.conversations;

  // `readVolumeBanner` only returns a level for a capped reading, so this is
  // narrowing rather than a fallback.
  if (cap === null) {
    return null;
  }

  const copy = content.billing.volumeBanner;
  const usedText = formatCount(used, content.locale);
  const capText = formatCount(cap, content.locale);

  return (
    <AlertBanner
      tone={level === 'reached' ? 'danger' : 'warning'}
      heading={level === 'reached' ? copy.reachedHeading : copy.approachingHeading}
      action={
        withAction ? <TextLink href={routes.settingsBilling()}>{copy.action}</TextLink> : undefined
      }
    >
      <p>
        {level === 'reached'
          ? copy.reachedBody(usedText, capText)
          : copy.approachingBody(usedText, capText)}
      </p>
    </AlertBanner>
  );
}
