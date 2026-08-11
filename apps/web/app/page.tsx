import { redirect } from 'next/navigation';
import { routes } from '@/lib/routes';

/**
 * The console has no separate landing page: every role's home is the inbox, and an
 * agent's role-scoped view of it is the first thing they should see.
 */
export default function HomePage() {
  redirect(routes.inbox());
}
