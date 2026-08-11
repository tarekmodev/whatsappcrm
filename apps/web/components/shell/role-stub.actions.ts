'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { ROLE_STUB_COOKIE_NAME } from '@/lib/session/role-stub';

/**
 * ⚠️ INTERIM STUB (TAR-35). Writes the demo role cookie, and refuses outright
 * unless the stub flag is on — so this action is inert in any environment that has
 * not explicitly opted in, and cannot be reached in production at all.
 */
export async function setStubRoleAction(role: TenantRole): Promise<void> {
  if (!webEnv.enableRoleStub || webEnv.isProduction) {
    throw new Error('The role stub is disabled. Roles come from the TAR-35 session.');
  }

  if (!TENANT_ROLES.includes(role)) {
    // A server action is a public endpoint; its argument is untrusted.
    throw new Error('Unknown role.');
  }

  const cookieStore = await cookies();

  cookieStore.set(ROLE_STUB_COOKIE_NAME, role, {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
  });

  // Every page's permission gate reads this, so the whole tree is stale.
  revalidatePath('/', 'layout');
}
