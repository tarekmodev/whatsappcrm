import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { LOCALE_ENDONYMS } from '@/lib/locale/locale';
import { content as webContent } from '@/content/en';
import { AdminBar } from './AdminBar';

/**
 * The bar's language toggle (TAR-806).
 *
 * `AdminBar` is an async server component, so it is awaited and the result
 * rendered — which is what a server render does, and what makes the two copies
 * of the toggle assertable in one tree.
 *
 * The property under test is **arrangement**, not behaviour: `LocaleToggle`'s own
 * flip, label and hydration are covered in `apps/web`. What is this app's is that
 * the control exists on both surfaces and that neither is the only one — a single
 * copy in the bar is what put a 320px row into horizontal scroll, because `.end`
 * is `flex: 0 0 auto` and this is a fifth item in a group sized for four.
 */

/*
 * The drawer closes on a route change and the forget control pushes after it
 * clears the cookie, so the bar needs both router hooks. Neither is exercised
 * here — this is about which controls are in the tree.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/tenants',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('~/lib/admin-env', () => ({ adminEnv: { deployment: 'local' } }));

vi.mock('@/lib/locale/read-locale', () => ({ readLocale: () => Promise.resolve('en') }));

const enableLocaleSwitch = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/config/env', () => ({
  webEnv: {
    get enableLocaleSwitch() {
      return enableLocaleSwitch.value;
    },
    isProduction: false,
  },
}));

/** The forget control reads the toast context the console layout gives it. */
async function renderBar() {
  return render(<ToastProvider>{await AdminBar()}</ToastProvider>);
}

describe('AdminBar: the language toggle', () => {
  it('renders one copy for the drawer and one for the bar', async () => {
    enableLocaleSwitch.value = true;
    await renderBar();

    const toggles = screen.getAllByRole('button', {
      name: webContent.language.switchTo(LOCALE_ENDONYMS.ar),
    });

    expect(toggles).toHaveLength(2);
  });

  /*
   * The two are complementary rather than duplicated: 48rem is the width
   * `MobileMenu` itself stops existing at, so the bar's copy is hidden below it
   * and the drawer's is gone above it. Asserted through the class the media
   * query keys off, because jsdom resolves no media queries — the widths
   * themselves are checked in a browser.
   */
  it('hides the bar copy at the width the drawer covers', async () => {
    enableLocaleSwitch.value = true;
    await renderBar();

    const toggles = screen.getAllByRole('button', {
      name: webContent.language.switchTo(LOCALE_ENDONYMS.ar),
    });
    const wrappers = toggles.map((toggle) => toggle.parentElement);

    expect(wrappers.filter((node) => /wideOnly/u.test(node?.className ?? ''))).toHaveLength(1);
  });

  it('renders neither copy when the switch is off', async () => {
    enableLocaleSwitch.value = false;
    await renderBar();

    expect(
      screen.queryByRole('button', {
        name: webContent.language.switchTo(LOCALE_ENDONYMS.ar),
      }),
    ).toBeNull();
  });
});
