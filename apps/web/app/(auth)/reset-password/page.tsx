import type { Metadata } from 'next';
import { content } from '@/content/en';
import { ResetPasswordForm } from '@/features/auth/components/ResetPasswordForm';

/**
 * Redeem a password-reset link. The target of `RESET_PASSWORD_LINK_PATH` in the
 * emails TAR-57 sends — kept in step with it through `routes.resetPassword()`.
 *
 * The token arrives in the URL **fragment**, which the server never sees, so
 * everything below this file is client-rendered on purpose. That is the cost of
 * keeping a live credential out of the access logs, and it is paid here rather
 * than by putting the token in a query string.
 */

export const metadata: Metadata = {
  title: `${content.auth.resetTitle} · ${content.app.name}`,
  description: content.auth.resetDescription,
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
