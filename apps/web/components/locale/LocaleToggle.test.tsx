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

/** The button offering a switch *to* `locale`. */
function offering(locale: 'en' | 'ar') {
  return screen.getByRole('button', {
    name: content.language.switchTo(LOCALE_ENDONYMS[locale]),
  });
}

function allOffering(locale: 'en' | 'ar') {
  return screen.getAllByRole('button', {
    name: content.language.switchTo(LOCALE_ENDONYMS[locale]),
  });
}

describe('LocaleToggle', () => {
  it('names the language it would switch to, in that language', () => {
    render(<LocaleToggle initialLocale="en" />);

    expect(offering('ar')).toHaveTextContent(LOCALE_ENDONYMS.ar);
  });

  /*
   * SC 2.5.3: the visible label has to be part of the accessible name, or a
   * reader who says the words on the button cannot operate it by voice.
   */
  it('keeps the visible label inside the accessible name', () => {
    render(<LocaleToggle initialLocale="en" />);

    expect(offering('ar').getAttribute('aria-label')).toContain(LOCALE_ENDONYMS.ar);
  });

  /*
   * The endonym is in a different script from the interface around it. Without
   * its own `lang`, a screen reader reads Arabic letters with an English voice —
   * and the `[lang]` rule in `base.css` is what paints it in the Arabic face.
   */
  it('marks the endonym with its own language', () => {
    render(<LocaleToggle initialLocale="en" />);

    expect(screen.getByText(LOCALE_ENDONYMS.ar)).toHaveAttribute('lang', 'ar');
  });

  it('flips the document’s language and direction on the spot', () => {
    document.documentElement.lang = 'en';
    render(<LocaleToggle initialLocale="en" />);

    fireEvent.click(offering('ar'));

    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('persists the choice through the server action', async () => {
    document.documentElement.lang = 'en';
    render(<LocaleToggle initialLocale="en" />);

    fireEvent.click(offering('ar'));

    await waitFor(() => {
      expect(setLocaleAction).toHaveBeenCalledWith('ar');
    });
  });

  /*
   * `<html lang>` is the state, not the prop. The server writes it, the click
   * writes it, and render reads it — so an instance mounted with a stale prop
   * still labels itself correctly.
   */
  it('labels itself from the document rather than from its prop', async () => {
    document.documentElement.lang = 'ar';
    render(<LocaleToggle initialLocale="en" />);

    await waitFor(() => {
      expect(offering('en')).toBeInTheDocument();
    });
  });

  it('switches back from Arabic', async () => {
    document.documentElement.lang = 'ar';
    render(<LocaleToggle initialLocale="ar" />);

    fireEvent.click(offering('en'));

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');

    await waitFor(() => {
      expect(setLocaleAction).toHaveBeenCalledWith('en');
    });
  });

  /*
   * The bar mounts this twice — `AppTopBar` hands the same `utilities` node to
   * `PrincipalMenu` and to `MobileMenu`, and the drawer keeps its children in
   * the DOM while closed, so that instance never remounts.
   *
   * With the locale in component state the two copies drifted: pressing the one
   * in the account menu left the drawer's still reading `العربية` while a press
   * on it would switch to English — the visible label naming the opposite of
   * what the control does, on the one control whose reader may not be able to
   * read the interface around it.
   */
  it('keeps a second instance in step with the first', async () => {
    document.documentElement.lang = 'en';
    render(
      <>
        <LocaleToggle initialLocale="en" />
        <LocaleToggle initialLocale="en" />
      </>,
    );

    expect(allOffering('ar')).toHaveLength(2);

    fireEvent.click(allOffering('ar')[0] as HTMLElement);

    await waitFor(() => {
      expect(allOffering('en')).toHaveLength(2);
    });

    expect(
      screen.queryByRole('button', { name: content.language.switchTo(LOCALE_ENDONYMS.ar) }),
    ).not.toBeInTheDocument();
  });

  /* The label and the action must never disagree about their target. */
  it('switches to the language its label names, from either instance', async () => {
    document.documentElement.lang = 'en';
    render(
      <>
        <LocaleToggle initialLocale="en" />
        <LocaleToggle initialLocale="en" />
      </>,
    );

    fireEvent.click(allOffering('ar')[0] as HTMLElement);

    await waitFor(() => {
      expect(allOffering('en')).toHaveLength(2);
    });

    // The instance nobody pressed. It now reads "English", so it must give English.
    const second = allOffering('en')[1] as HTMLElement;

    expect(second).toHaveTextContent(LOCALE_ENDONYMS.en);

    fireEvent.click(second);

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');

    await waitFor(() => {
      expect(setLocaleAction).toHaveBeenLastCalledWith('en');
    });
  });
});
