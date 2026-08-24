import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from './Tooltip';

/**
 * What a tooltip has to get right whatever it is attached to: the delay a
 * pointer waits out and the one a keyboard never does, the four ways it is
 * dismissed, and the wiring that decides whether a screen reader hears it once,
 * twice or not at all.
 *
 * jsdom lays nothing out and runs no transitions, so placement is not covered
 * here — `getBoundingClientRect` is 0×0 for everything and a flip test would
 * only assert the stub. The exit unmounts immediately for the same reason, which
 * is the fallback `useExitTransition` exists to provide.
 */
describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    // The group's warmth outlives a component, so it has to be cooled between
    // cases or the second test in a file inherits the first one's zero delay.
    act(() => {
      vi.advanceTimersByTime(GROUP_COOLED_MS);
    });
    vi.useRealTimers();
  });

  function renderTooltip() {
    render(
      <Tooltip tip="Archive">
        {(trigger) => (
          <button {...trigger} type="button">
            Archive
          </button>
        )}
      </Tooltip>,
    );

    return screen.getByRole('button', { name: 'Archive' });
  }

  it('waits out the delay before the first tooltip in a group', () => {
    const trigger = renderTooltip();

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(OPEN_DELAY_MS);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent('Archive');
  });

  it('shows the next one in a warm group with no delay at all', () => {
    const trigger = renderTooltip();

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(OPEN_DELAY_MS);
    });
    fireEvent.pointerLeave(trigger);

    // Scanning along a row of icon buttons: the reader has already waited once.
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('appears immediately for the keyboard and stays until blur', () => {
    // A tooltip that only answers to a pointer is a label a keyboard user never
    // gets — so there is no delay to advance past here.
    const trigger = renderTooltip();

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('never opens on touch, where there is no hover to rest', () => {
    const trigger = renderTooltip();

    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(OPEN_DELAY_MS);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('is dismissed by Escape, by a scroll and by pressing the trigger', () => {
    const trigger = renderTooltip();

    for (const dismiss of [
      () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      },
      () => {
        fireEvent.scroll(document, {});
      },
      () => {
        fireEvent.pointerDown(trigger);
      },
    ]) {
      fireEvent.focus(trigger);
      expect(screen.getByRole('tooltip')).toBeInTheDocument();

      dismiss();
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    }
  });

  it('leaves a pending tooltip unopened when the pointer moves on', () => {
    const trigger = renderTooltip();

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    fireEvent.pointerLeave(trigger);

    act(() => {
      vi.advanceTimersByTime(OPEN_DELAY_MS);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('renders the trigger and nothing else when there is no tip', () => {
    // The shape the rail uses at full width: one expression, no tooltip.
    render(
      <Tooltip>
        {(trigger) => (
          <button {...trigger} type="button">
            Archive
          </button>
        )}
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Archive' });

    fireEvent.focus(trigger);
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(OPEN_DELAY_MS);
    });

    expect(trigger).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('describes a control that has its own name, and labels one that has none', () => {
    const { unmount } = render(
      <Tooltip tip="Archive">
        {(trigger) => (
          <button {...trigger} type="button">
            Archive
          </button>
        )}
      </Tooltip>,
    );

    const described = screen.getByRole('button', { name: 'Archive' });

    fireEvent.focus(described);
    expect(described).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    expect(described).not.toHaveAttribute('aria-labelledby');
    unmount();

    render(
      <Tooltip tip="Archive" relationship="labels">
        {(trigger) => (
          <button {...trigger} type="button" data-testid="labelled">
            <span aria-hidden="true">▣</span>
          </button>
        )}
      </Tooltip>,
    );

    // Nameless until the tip supplies one, which is what `labels` means — and
    // why a control that needs this on touch is a control drawn wrong.
    const labelled = screen.getByTestId('labelled');

    fireEvent.focus(labelled);
    expect(labelled).toHaveAccessibleName('Archive');
    expect(labelled).toHaveAttribute('aria-labelledby', screen.getByRole('tooltip').id);
    expect(labelled).not.toHaveAttribute('aria-describedby');
  });
});

/** Mirrors `TOOLTIP_OPEN_DELAY_MS`, which is the component's own. */
const OPEN_DELAY_MS = 500;
/** Long enough for `TOOLTIP_GROUP_WARM_MS` to have elapsed. */
const GROUP_COOLED_MS = 1000;
