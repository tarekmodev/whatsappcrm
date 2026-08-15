import { Stack } from '@/components/layout/Stack';
import { DetailList } from '@/components/ui/DetailList';
import { Notice } from '@/components/ui/Notice';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';

/**
 * Mirrors `BrandingSummary` — the same stack and gap, the same four detail rows
 * with the same terms, the same notice — so the card does not change height when
 * the tenant record lands.
 *
 * The notice is rendered with its real copy rather than shimmered: it says the
 * branding editor has not shipped yet, which is true before the data arrives and
 * after it, and shimmering a sentence that cannot change would be theatre.
 *
 * Changed in the same commit as the summary it stands in for.
 */
export function BrandingSummarySkeleton() {
  const content = useContent();

  return (
    <Stack gap="4">
      <DetailList
        items={[
          {
            id: 'product-name',
            term: content.workspace.brandingProductName,
            value: <SkeletonLine width="10rem" />,
          },
          {
            id: 'primary-colour',
            term: content.workspace.brandingPrimaryColour,
            value: <SkeletonLine width="6rem" />,
          },
          {
            id: 'accent-colour',
            term: content.workspace.brandingAccentColour,
            value: <SkeletonLine width="6rem" />,
          },
          {
            id: 'logo',
            term: content.workspace.brandingLogo,
            value: <SkeletonLine width="12rem" />,
          },
        ]}
      />
      <Notice tone="info">{content.workspace.brandingPendingNotice}</Notice>
    </Stack>
  );
}
