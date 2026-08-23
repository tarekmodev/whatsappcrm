import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { KnowledgeFilterBar } from './KnowledgeFilterBar';

/**
 * TAR-613's URL contract, asserted from the reader's side: what they type and
 * choose becomes the URL, and the URL is what a refresh, a copied link and the
 * back button reproduce.
 *
 * `useSearchParams` is the URL, so the tests drive it directly rather than
 * mounting a router — the component's whole job is the translation between the
 * two, and a real router would only test Next.
 */

const replace = vi.fn();
let currentParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => currentParams,
}));

function renderBar(search = '') {
  currentParams = new URLSearchParams(search);

  return render(<KnowledgeFilterBar />);
}

function searchBox() {
  return screen.getByRole('searchbox', { name: content.chatbot.searchEntriesLabel });
}

function statusSelect() {
  return screen.getByRole('combobox', { name: content.chatbot.filterStatusLabel });
}

beforeEach(() => {
  replace.mockClear();
});

describe('KnowledgeFilterBar', () => {
  it('puts a typed term in the URL, once, after the debounce', async () => {
    renderBar();

    fireEvent.change(searchBox(), { target: { value: 'returns' } });

    // Nothing yet: a navigation per keystroke is what the debounce exists to stop.
    expect(replace).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(routes.settingsChatbot({ q: 'returns' }), {
        scroll: false,
      });
    });
  });

  it('navigates immediately on a status choice — a discrete pick has nothing to debounce', () => {
    renderBar();

    fireEvent.change(statusSelect(), { target: { value: 'failed' } });

    expect(replace).toHaveBeenCalledWith(routes.settingsChatbot({ status: 'failed' }), {
      scroll: false,
    });
  });

  it('carries the search term through a status change, and the status through a search', async () => {
    renderBar('q=returns&status=failed');

    fireEvent.change(statusSelect(), { target: { value: 'indexed' } });
    expect(replace).toHaveBeenCalledWith(
      routes.settingsChatbot({ q: 'returns', status: 'indexed' }),
      { scroll: false },
    );

    // `indexed`, not the `failed` the URL still says: the status the reader has
    // just chosen is the one the search must carry, whether or not its
    // navigation has landed (TAR-780).
    fireEvent.change(searchBox(), { target: { value: 'delivery' } });
    await waitFor(() => {
      expect(replace).toHaveBeenLastCalledWith(
        routes.settingsChatbot({ q: 'delivery', status: 'indexed' }),
        { scroll: false },
      );
    });
  });

  it('carries a status whose navigation has not landed yet (TAR-780)', async () => {
    // `useSearchParams` is the URL that has *landed*. Between the select's
    // replace and the URL arriving it still says "all statuses", and a debounce
    // tick in that window used to navigate without the status — sending the
    // select back to "All statuses" without the reader touching it. The spy
    // never updates the params, so this test sits inside that window.
    renderBar();

    fireEvent.change(statusSelect(), { target: { value: 'failed' } });
    fireEvent.change(searchBox(), { target: { value: 'returns' } });

    await waitFor(() => {
      expect(replace).toHaveBeenLastCalledWith(
        routes.settingsChatbot({ q: 'returns', status: 'failed' }),
        { scroll: false },
      );
    });
  });

  it('keeps the status when the search is cleared, and drops `q` from the URL', async () => {
    renderBar('q=returns&status=failed');

    fireEvent.click(screen.getByRole('button', { name: content.common.clearSearch }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(routes.settingsChatbot({ status: 'failed' }), {
        scroll: false,
      });
    });
  });

  it('clearing the status filter leaves a bare route, not `?status=`', () => {
    renderBar('status=failed');

    fireEvent.change(statusSelect(), { target: { value: '' } });

    expect(replace).toHaveBeenCalledWith(routes.settingsChatbot(), { scroll: false });
    expect(replace).toHaveBeenCalledWith('/settings/chatbot', { scroll: false });
  });

  it('shows the view the URL describes, so a deep link and the back button reproduce it', () => {
    renderBar('q=returns&status=indexed');

    expect(searchBox()).toHaveValue('returns');
    expect(statusSelect()).toHaveValue('indexed');
  });

  it('falls back to every entry for a status the contract does not name', () => {
    // A hand-edited or stale link degrades to the unfiltered view rather than
    // leaving the select on a value none of its options carries.
    renderBar('status=archived');

    expect(statusSelect()).toHaveValue('');
  });

  it('caps the box at the length the API accepts, so it cannot produce a term the parser drops', () => {
    renderBar();

    expect(searchBox()).toHaveAttribute('maxlength', '120');
  });

  it('offers the statuses most-looked-for first, labelled as the rows label them', () => {
    renderBar();

    expect(
      Array.from(statusSelect().querySelectorAll('option')).map((option) => option.textContent),
    ).toEqual([
      content.chatbot.filterStatusAll,
      content.chatbot.statuses.indexed,
      content.chatbot.statuses.pending,
      content.chatbot.statuses.failed,
    ]);
  });
});
