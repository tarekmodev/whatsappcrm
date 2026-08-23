import { redirect } from 'next/navigation';
import { AuthCard } from '@/features/auth/components/AuthCard';
import { webEnv } from '@/lib/config/env';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { content } from '~/content/en';
import { readCredential } from '~/lib/credential';
import { parseRedirectPath, routes, searchParamKeys } from '~/lib/routes';
import { CredentialForm } from '~/features/credential/components/CredentialForm';

/**
 * Where an operator presents their credential. Composition only: it narrows
 * `?next=` and hands the form a destination it can trust.
 *
 * An operator who already holds a credential is sent straight on rather than
 * shown a form they have no reason to fill in. Presence is all this checks;
 * whether the value is still accepted is answered by the first call the console
 * makes with it, which renders the refusal state rather than bouncing back here.
 */

/** Reads a cookie, so there is nothing to prerender. */
export const dynamic = 'force-dynamic';

export default async function CredentialPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const params = await searchParams;
  const destination = parseRedirectPath(
    firstSearchParam(params[searchParamKeys.redirectTo]),
    routes.tenants(),
  );

  /*
   * Before the form, because there is no token that would work: with
   * `NEXT_PUBLIC_USE_MOCK_API` on, every call this console makes is answered by
   * `apps/web`'s fixture router, which has no platform surface at all. Offering
   * the field anyway would spend somebody's time pasting a secret to be told it
   * was refused. `lib/api/admin.ts` refuses the same way for any other route in.
   */
  if (webEnv.useMockApi) {
    return (
      <AuthCard
        title={content.credential.mockApiTitle}
        description={content.credential.mockApiBody}
        icon="warning"
        tone="danger"
      >
        <></>
      </AuthCard>
    );
  }

  if ((await readCredential()) !== null) {
    redirect(destination);
  }

  return <CredentialForm redirectTo={destination} />;
}
