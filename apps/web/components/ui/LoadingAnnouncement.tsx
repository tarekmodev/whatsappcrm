import { VisuallyHidden } from '@/components/layout/VisuallyHidden';

/**
 * The single polite announcement that accompanies a skeleton. Usage:
 * `<LoadingAnnouncement label="Loading agents" />`.
 *
 * Skeleton nodes themselves are `aria-hidden`, so a screen reader hears one
 * sentence instead of a hundred placeholders. `role="status"` is polite and does
 * not move focus, so focus survives the swap to real content.
 */
export function LoadingAnnouncement({ label }: { label: string }) {
  return (
    <VisuallyHidden>
      <span role="status">{label}</span>
    </VisuallyHidden>
  );
}
