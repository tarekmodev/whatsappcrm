import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { LOCALE_ENDONYMS } from '@/lib/locale/locale';
import { LocaleToggle } from './LocaleToggle';

const setLocaleAction = vi.fn<(locale: string) => Promise<void>>(async () => {});

vi.mock('./locale.actions', () => ({
  setLocaleAction: (locale: string) => setLocaleAction(locale),
}));

afterEach(() => {
  setLocaleAction.mockClear();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

function toggle() {
  return screen.getByRole('button', {
    name: content.language.switchTo(LOCALE_ENDONYMS.ar),
  });
}

describe('LocaleToggle', () => {
  it('names the language it would switch to, in that language', () => {
    render(<LocaleToggle initialLocale="en" />);

    expect(toggle()).toHaveTextContent(LOCALE_ENDONYMS.ar);
  });

  /*
   * SC 2.5.3: the visible label has to be part of the accessible name, or a
   * reader who says the words on the button cannot operate it by voice.
   */
  it('keeps the visible label inside the accessible name', () => {
    render(<LocaleToggle initialLocale="en" />);

    expect(toggle().getAttribute('aria-label')).toContain(LOCALE_ENDONYMS.ar);
  });

  /*
   * The endonym is in a different script from the interface around it. Without
   * its own `lang`, a screen reader reads Arabic letters with an English voice.
   */
  it('marks the endonym with its own language', () => {
    render(<LocaleToggle initialLocale="en" />);

    expect(screen.getByText(LOCALE_ENDONYMS.ar)).toHaveAttribute('lang', 'ar');
  });

  it('flips the document’s language and direction on the spot', () => {
    document.documentElement.lang = 'en';
    render(<LocaleToggle initialLocale="en" />);

    fireEvent.click(toggle());

    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('persists the choice through the server action', async () => {
    document.documentElement.lang = 'en';
    render(<LocaleToggle initialLocale="en" />);

    fireEvent.click(toggle());

    await waitFor(() => {
      expect(setLocaleAction).toHaveBeenCalledWith('ar');
    });
  });

  /*
   * The bar renders one instance for the account menu and one for the drawer.
   * Reading the current locale from the document rather than from local state is
   * what stops the second one switching back to where the first one started.
   */
  it('reads the current locale from the document, not from its own state', () => {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    render(<LocaleToggle initialLocale="en" />);

    fireEvent.click(toggle());

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('switches back from Arabic', () => {
    document.documentElement.lang = 'ar';
    render(
      <LocaleToggle initialLocale="ar" />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: content.language.switchTo(LOCALE_ENDONYMS.en) }),
    );

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
