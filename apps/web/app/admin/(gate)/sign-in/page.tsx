import { redirect } from 'next/navigation';
import { content } from '@/content/en';
import { webEnv } from '@/lib/config/env';
import { AuthCard } from '@/features/auth/components/AuthCard';
import { ADMIN_PATH_PREFIX } from '@/lib/admin/admin-paths';
import { readPlatformCredential } from '@/lib/admin/platform-credential';
import { parseRedirectPath, routes, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { AdminSignInForm } from '@/features/platform-admin/components/AdminSignInForm';

/**
 * Where a platform operator presents their credential. Composition only: it
 * narrows `?next=` and hands the form a destination it can trust.
 *
 * An operator who already has a credential is sent straight on rather than shown
 * a form they have no reason to fill in — the same courtesy the tenant sign-in
 * screen owes a signed-in user. Presence is all this checks; whether the value is
 * still accepted is answered by the first call the console makes with it, which
 * redirects back here if it is not.
 */

/** Reads a cookie, so there is nothing to prerender. */
export const dynamic = 'force-dynamic';

export default async function PlatformAdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const params = await searchParams;
  const destination = adminDestination(firstSearchParam(params[searchParamKeys.redirectTo]));

  /*
   * Before the form, because there is no token that would work: with
   * `NEXT_PUBLIC_USE_MOCK_API` on, every call this console makes is answered by
   * the fixture router, which has no platform surface at all. Offering the field
   * anyway would spend somebody's time pasting a secret to be told "we could not
   * save that". `lib/api/admin.ts` refuses the same way for any other way in.
   */
  if (webEnv.useMockApi) {
    return (
      <AuthCard
        title={content.platformAdmin.signIn.mockApiTitle}
        description={content.platformAdmin.signIn.mockApiBody}
        icon="warning"
        tone="danger"
      >
        <></>
      </AuthCard>
    );
  }

  if ((await readPlatformCredential()) !== null) {
    redirect(destination);
  }

  return <AdminSignInForm redirectTo={destination} />;
}

/**
 * Narrows `?next=` twice: to a path inside this app, and then to one inside
 * `/admin`.
 *
 * The first is `parseRedirectPath`'s open-redirect check, which every sign-in
 * screen here owes. The second is this surface's own — a platform credential
 * authenticates nobody inside any tenant, so following it to a tenant screen
 * would drop the operator on a page that immediately bounces them to a *second*
 * sign-in, having lost where they were going.
 */
function adminDestination(requested: string | undefined): string {
  const path = parseRedirectPath(requested, routes.adminTenants());

  return path.startsWith(ADMIN_PATH_PREFIX) ? path : routes.adminTenants();
}
