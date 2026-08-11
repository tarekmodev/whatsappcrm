import { content } from '@/content/en';
import { EmptyState } from './EmptyState';

/**
 * What a principal sees when they reach a route their role does not include.
 * Usage: returned from a page whose `requirePermission` came back `null`.
 *
 * A real, explanatory state rather than a redirect: silently bouncing someone to
 * the inbox hides what happened and makes a shared link look broken.
 */
export function ForbiddenState() {
  return (
    <EmptyState heading={content.errors.forbiddenHeading} body={content.errors.forbiddenBody} />
  );
}
