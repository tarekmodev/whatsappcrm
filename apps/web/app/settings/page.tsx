import { redirect } from 'next/navigation';
import { resolveSession } from '@/lib/session/session';
import { settingsNavItems } from '@/components/shell/navigation';
import { ForbiddenState } from '@/components/ui/ForbiddenState';

/**
 * `/settings` itself has no content — it sends the principal to the first section
 * their role can actually reach, so a supervisor and an admin each land somewhere
 * useful without the URL needing to know which sections exist.
 */
export const dynamic = 'force-dynamic';

export default async function SettingsIndexPage() {
  const { checker } = await resolveSession();
  const [first] = settingsNavItems(checker);

  if (first === undefined) {
    return <ForbiddenState />;
  }

  redirect(first.href);
}
