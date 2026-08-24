import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_COOKIE_NAME } from './locale';
import { readLocale } from './read-locale';

/**
 * The flag has to mean "off" on the *read*, not only on the control.
 *
 * The cookie is `httpOnly` with a year's `maxAge`, so a reader who switched to
 * Arabic while the switch was enabled cannot undo it from the page once it is
 * disabled — no toggle is rendered, and script cannot clear an `httpOnly`
 * cookie. If the read still honoured the cookie they would be stranded in a
 * mirrored console with the `lang="ar"` mispronunciation the flag exists to
 * prevent.
 */

const { env, cookieValue } = vi.hoisted(() => ({
  env: { enableLocaleSwitch: true },
  cookieValue: { current: undefined as string | undefined },
}));

vi.mock('@/lib/config/env', () => ({ webEnv: env }));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === LOCALE_COOKIE_NAME && cookieValue.current !== undefined
          ? { value: cookieValue.current }
          : undefined,
    }),
}));

afterEach(() => {
  env.enableLocaleSwitch = true;
  cookieValue.current = undefined;
});

describe('readLocale', () => {
  it('reads the stored locale when the switch is enabled', async () => {
    cookieValue.current = 'ar';

    await expect(readLocale()).resolves.toBe('ar');
  });

  it('falls back to the default when nothing is stored', async () => {
    await expect(readLocale()).resolves.toBe('en');
  });

  it('refuses a cookie value that is not a locale', async () => {
    cookieValue.current = 'zz--not-a-locale';

    await expect(readLocale()).resolves.toBe('en');
  });

  /* The trap this exists to close: no toggle on the page, and no way to clear it. */
  it('ignores a stored locale once the switch is disabled', async () => {
    cookieValue.current = 'ar';
    env.enableLocaleSwitch = false;

    await expect(readLocale()).resolves.toBe('en');
  });
});
