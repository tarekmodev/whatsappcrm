import { AlertBanner } from '@/components/ui/AlertBanner';
import { DetailList } from '@/components/ui/DetailList';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useContent } from '@/lib/content';

/**
 * The banner for a subscription somebody has asked to cancel. Usage:
 * `<CancellationBanner cancelsAt={summary.cancelsAt} />` — renders nothing when
 * it is `null`, so the caller needs no conditional of its own.
 *
 * **`cancelsAt` being set does not mean the workspace is cancelled**, and this
 * banner exists to say so. The provider reports a cancellation the moment a
 * customer *requests* one, and they have paid through the end of the period —
 * the contract's decision 5 maps that to no lifecycle transition at all,
 * precisely so a tenant is not locked out of a period it has already bought on
 * the day it clicks cancel. Copy that read "your workspace is closed" would
 * contradict the API and alarm somebody who has weeks left.
 *
 * `warning`, not `danger`: nothing is broken and nothing has been lost. The date
 * is a `RelativeTime`, so the server renders a stable absolute value and the
 * client upgrades it after mount — splicing a formatted date into the sentence
 * cannot be translated and would put date formatting in the content layer.
 */
export function CancellationBanner({ cancelsAt }: { cancelsAt: string | null }) {
  const content = useContent();

  if (cancelsAt === null) {
    return null;
  }

  const copy = content.billing.cancellationBanner;

  return (
    <AlertBanner tone="warning" heading={copy.heading}>
      <p>{copy.body}</p>
      <DetailList
        items={[
          {
            id: 'cancels-at',
            term: copy.dateLabel,
            value: <RelativeTime isoTimestamp={cancelsAt} label={copy.dateLabel} />,
          },
        ]}
      />
    </AlertBanner>
  );
}
