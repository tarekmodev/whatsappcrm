import { redirect } from 'next/navigation';
import { routes } from '~/lib/routes';

/**
 * The root has no screen of its own.
 *
 * Tenants rather than a dashboard, and the API decides that rather than taste: a
 * dashboard would need cross-tenant counts, revenue or a health roll-up, and
 * `/api/v1/admin/*` exposes none of them (spec §2.0). A landing screen built from
 * what does exist would be the tenant lookup with a heading over it.
 */
export default function IndexPage() {
  redirect(routes.tenants());
}
