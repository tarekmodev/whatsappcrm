import type { Metadata } from 'next';
import { content } from '@/content/en';
import { parseRedirectPath, routes, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { AuthCard } from '@/features/auth/components/AuthCard';
import { LoginForm } from '@/features/auth/components/LoginForm';

/**
 * Sign in. Composition only: read where to go afterwards, then hand it to the
 * form.
 *
 * `?next=` is read here on the server rather than with `useSearchParams` in the
 * form, so the untrusted value is narrowed to an in-app path in one place and the
 * client component never has to think about open redirects.
 */

export const metadata: Metadata = {
  title: `${content.auth.signInTitle} · ${content.app.name}`,
  description: content.auth.signInDescription,
  // A sign-in screen has nothing to index, and an indexed one collects search
  // traffic aimed at whatever it redirects to.
  robots: { index: false, follow: false },
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

  return (
    <AuthCard title={content.auth.signInTitle} description={content.auth.signInDescription}>
      <LoginForm redirectTo={redirectTo} />
    </AuthCard>
  );
}
