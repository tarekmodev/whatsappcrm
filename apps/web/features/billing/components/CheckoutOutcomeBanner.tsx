import { AlertBanner } from '@/components/ui/AlertBanner';
import { TextLink } from '@/components/ui/TextLink';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import type { CheckoutReport } from '../plan-presentation';

/**
 * What the page says when the browser comes back from a hosted checkout page.
 * Usage: `<CheckoutOutcomeBanner report={report} />` — renders nothing when the
 * page was not reached from a checkout, so the caller needs no conditional.
 *
 * The three-way split is `reportCheckout`'s and the reasoning is there; what
 * matters here is that the **`confirming`** case is a first-class state with its
 * own affordance rather than a silent fall-through. The provider's redirect
 * routinely beats its own webhook, so "we have your payment and are waiting for
 * the provider to confirm it" is the true sentence more often than not for the
 * first few seconds — and the honest thing to offer alongside it is a way to
 * look again.
 *
 * That way is a **link back to this page with no parameters**, not a client-side
 * poll. It clears the `?checkout=` state on arrival, so a refresh after the plan
 * has landed does not re-announce a payment; it costs no timer that has to be
 * cancelled on unmount; and it works with the Back button, which a poll does not.
 */
export function CheckoutOutcomeBanner({ report }: { report: CheckoutReport | null }) {
  const content = useContent();

  if (report === null) {
    return null;
  }

  const copy = content.billing.outcome;

  if (report.kind === 'succeeded') {
    return (
      <AlertBanner tone="info" heading={copy.succeededHeading}>
        <p>{copy.succeededBody(report.planName)}</p>
      </AlertBanner>
    );
  }

  if (report.kind === 'cancelled') {
    return (
      <AlertBanner tone="info" heading={copy.cancelledHeading}>
        <p>{copy.cancelledBody}</p>
      </AlertBanner>
    );
  }

  return (
    <AlertBanner
      tone="warning"
      heading={copy.confirmingHeading}
      action={<TextLink href={routes.settingsBilling()}>{copy.confirmingAction}</TextLink>}
    >
      <p>{copy.confirmingBody}</p>
    </AlertBanner>
  );
}
