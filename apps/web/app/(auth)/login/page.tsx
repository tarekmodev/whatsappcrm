import type { Metadata } from 'next';
import { content } from '@/content/en';
import { parseRedirectPath, routes, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { LoginForm } from '@/features/auth/components/LoginForm';

/**
 * Sign in. Composition only: read where to go afterwards, then hand it to the
 * form.
 *
 * `?next=` is read here on the server rather than with `useSearchParams` in the
 * form, so the untrusted value is narrowed to an in-app path in exactly one place
 * and the client component never has to think about open redirects. It is written
 * by the session guard (TAR-62) and by anybody who can send a link, which is the
 * same thing as far as this page is concerned.
 *
 * `robots` comes from the `(auth)` layout and is inherited.
 */

export const metadata: Metadata = {
  title: `${content.auth.signInTitle} · ${content.app.name}`,
  description: content.auth.signInDescription,
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const params = await searchParams;
  const redirectTo = parseRedirectPath(
    firstSearchParam(params[searchParamKeys.redirectTo]),
    routes.inbox(),
  );

  return <LoginForm redirectTo={redirectTo} />;
}
