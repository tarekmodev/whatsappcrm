import type { Metadata } from 'next';
import { content } from '@/content/en';
import { ForgotPasswordForm } from '@/features/auth/components/ForgotPasswordForm';

/**
 * Request a password-reset link. Reachable signed out, by definition — somebody
 * who could sign in would not be here.
 *
 * Static: it renders the same markup for everybody and reads nothing per request,
 * which is also what makes it cheap to serve to whatever traffic finds it.
 */

export const metadata: Metadata = {
  title: content.auth.forgotTitle,
  description: content.auth.forgotDescription,
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
