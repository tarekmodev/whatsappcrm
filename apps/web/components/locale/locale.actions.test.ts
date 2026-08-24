import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_COOKIE_NAME } from '@/lib/locale/locale';
import { setLocaleAction } from './locale.actions';

/**
 * A server action stays a reachable endpoint whether or not a button points at
 * it, so both gates live here rather than at the call site: the feature flag,
 * and the untrusted argument.
 */

const { env, set } = vi.hoisted(() => ({
  env: { enableLocaleSwitch: true },
  set: vi.fn(),
}));

vi.mock('@/lib/config/env', () => ({ webEnv: env }));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ set }),
}));

afterEach(() => {
  env.enableLocaleSwitch = true;
  set.mockClear();
});

describe('setLocaleAction', () => {
  it('stores the locale in a long-lived, http-only cookie', async () => {
    await setLocaleAction('ar');

    expect(set).toHaveBeenCalledWith(
      LOCALE_COOKIE_NAME,
      'ar',
      expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('refuses a value that is not a locale', async () => {
    await expect(setLocaleAction('fr' as 'ar')).rejects.toThrow('Unknown locale.');
    expect(set).not.toHaveBeenCalled();
  });

  /*
   * Otherwise the action would write a preference `readLocale` refuses to read —
   * a stored choice that silently does nothing, which is worse than refusing it.
   */
  it('refuses to store anything while the switch is disabled', async () => {
    env.enableLocaleSwitch = false;

    await expect(setLocaleAction('ar')).rejects.toThrow('disabled');
    expect(set).not.toHaveBeenCalled();
  });
});
