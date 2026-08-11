import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CursorPage, MessageTemplateResponse } from '@whatsappcrm/contracts';
import type { ActionResult } from '@/lib/actions/result';
import { useTemplateSearch } from './useTemplateSearch';

const listTemplatesAction = vi.fn();

vi.mock('@/features/inbox/composer.actions', () => ({
  listTemplatesAction: (...args: unknown[]) => listTemplatesAction(...args) as unknown,
  sendMessageAction: vi.fn(),
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';

function template(name: string): MessageTemplateResponse {
  return {
    id: `0192f009-0000-7000-8000-00000000090${String(name.length)}`,
    whatsappBusinessAccountId: '0192f005-0000-7000-8000-000000000502',
    name,
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved',
    components: null,
    bodyText: 'Hello.',
    parameterCount: 0,
    headerFormat: null,
    headerParameterCount: 0,
    requiresButtonParameters: false,
    providerTemplateId: null,
    createdAt: '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-10T09:00:00.000Z',
  };
}

function page(
  items: readonly MessageTemplateResponse[],
  nextCursor: string | null,
): ActionResult<CursorPage<MessageTemplateResponse>> {
  return { status: 'success', data: { items: [...items], nextCursor } };
}

beforeEach(() => {
  listTemplatesAction.mockReset();
});

/**
 * The endpoint drops templates whose buttons take a parameter *after* reading
 * each page, so a short — or empty — page does not mean the end of the feed.
 * A caller that stops on the first page tells a tenant with hundreds of
 * templates that they have none.
 */
describe('useTemplateSearch', () => {
  it('reads one page when that page has templates', async () => {
    listTemplatesAction.mockResolvedValue(page([template('order_update')], null));

    const { result } = renderHook(() => useTemplateSearch(CONVERSATION_ID, ''));

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(listTemplatesAction).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({
      status: 'ready',
      templates: [template('order_update')],
      hasMore: false,
    });
  });

  it('follows the cursor past a page the button exclusion emptied', async () => {
    listTemplatesAction
      .mockResolvedValueOnce(page([], 'cursor-1'))
      .mockResolvedValueOnce(page([], 'cursor-2'))
      .mockResolvedValueOnce(page([template('invoice_ready')], null));

    const { result } = renderHook(() => useTemplateSearch(CONVERSATION_ID, ''));

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(result.current.state).toEqual({
      status: 'ready',
      templates: [template('invoice_ready')],
      hasMore: false,
    });
    // And it asked for the pages rather than guessing.
    expect(listTemplatesAction).toHaveBeenCalledTimes(3);
    expect(listTemplatesAction.mock.calls[1]?.[1]).toMatchObject({ cursor: 'cursor-1' });
    expect(listTemplatesAction.mock.calls[2]?.[1]).toMatchObject({ cursor: 'cursor-2' });
  });

  it('reports "there is more" rather than "empty" when it stops before the end', async () => {
    listTemplatesAction.mockResolvedValue(page([], 'cursor-n'));

    const { result } = renderHook(() => useTemplateSearch(CONVERSATION_ID, ''));

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    // The picker renders this as "search by name", never as "you have none".
    expect(result.current.state).toEqual({ status: 'ready', templates: [], hasMore: true });
  });

  it('stops at a genuinely empty feed', async () => {
    listTemplatesAction.mockResolvedValue(page([], null));

    const { result } = renderHook(() => useTemplateSearch(CONVERSATION_ID, ''));

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(result.current.state).toEqual({ status: 'ready', templates: [], hasMore: false });
    expect(listTemplatesAction).toHaveBeenCalledTimes(1);
  });

  it('surfaces a refusal rather than paging on through it', async () => {
    listTemplatesAction.mockResolvedValue({
      status: 'error',
      message: 'Your role does not include conversation:send.',
      requestId: 'req-9',
    });

    const { result } = renderHook(() => useTemplateSearch(CONVERSATION_ID, ''));

    await waitFor(() => {
      expect(result.current.state.status).toBe('failed');
    });
    expect(listTemplatesAction).toHaveBeenCalledTimes(1);
  });

  it('sends `q` only once something has been typed', async () => {
    listTemplatesAction.mockResolvedValue(page([template('order_update')], null));

    const { rerender } = renderHook(({ query }) => useTemplateSearch(CONVERSATION_ID, query), {
      initialProps: { query: '   ' },
    });

    await waitFor(() => {
      expect(listTemplatesAction).toHaveBeenCalledTimes(1);
    });
    // The contract's `q` has a floor of one character; blank means "everything".
    expect(listTemplatesAction.mock.calls[0]?.[1]).not.toHaveProperty('q');

    rerender({ query: ' order ' });

    await waitFor(() => {
      expect(listTemplatesAction).toHaveBeenCalledTimes(2);
    });
    expect(listTemplatesAction.mock.calls[1]?.[1]).toMatchObject({ q: 'order' });
  });
});
