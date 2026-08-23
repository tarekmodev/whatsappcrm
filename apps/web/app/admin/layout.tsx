import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { content } from '@/content/en';

/**
 * Everything under `/admin`, and the two things every operator screen shares:
 * it is never indexed, and it is never the tenant's brand.
 *
 * It renders no chrome and resolves no credential. Two groups sit under it and
 * they need different frames — `(console)` is the operator shell behind the
 * credential gate, `(gate)` is the screen where the credential is presented —
 * and gating here would mean an operator could not reach the form that fixes it.
 * That is the same split, for the same reason, as `(app)` and `(auth)` a level up.
 *
 * ## Why `/admin` is a path segment and the other two are route groups
 *
 * The prefix is load-bearing rather than cosmetic. `proxy.ts` reads it to decide
 * which of two credentials a request is missing, and the operator's cookie is
 * scoped to it so the platform token is never attached to a call to a tenant's
 * API. A route group would put these screens on `/tenants` and `/domains`,
 * colliding with the tenant console and losing both properties.
 *
 * `title` is `absolute` so the operator console does not wear a tenant's product
 * name. The root layout's template appends whichever tenant this host resolves to
 * — correct for every screen a customer reads, and misleading on a surface that
 * is not theirs.
 */

export const metadata: Metadata = {
  title: { absolute: content.platformAdmin.consoleName },
  description: content.platformAdmin.description,
  robots: { index: false, follow: false },
};

export default function PlatformAdminLayout({ children }: { children: ReactNode }) {
  return children;
}
