import { redirect } from 'next/navigation';
import { routes } from '@/lib/routes';

/**
 * `/admin` has no screen of its own — it is the prefix, not a destination.
 *
 * Tenants rather than a dashboard, and that is decided by the API rather than by
 * taste: an operator dashboard would need cross-tenant counts, revenue or a
 * health roll-up, and `/api/v1/admin/*` exposes none of them. A landing screen
 * built from what does exist would be the tenant lookup with a heading over it.
 */
export default function PlatformAdminIndexPage() {
  redirect(routes.adminTenants());
}
