import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { Modal } from './Modal';
import { TextInput } from './TextInput';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/people',
}));

/**
 * jsdom implements `<dialog>` but not `showModal`'s focus behaviour. The
 * `showModal`/`close` stubs live in `vitest.setup.ts`, because every test that
 * renders a dialog needs them; these cases cover the parts `Modal` owns itself:
 * opening the element, focusing the first form control rather than the close
 * button, and restoring focus to the invoker when the dialog unmounts on
 * dismissal.
 */

/**
 * `fireEvent.click` does not move focus, but a real click or Enter does — and the
 * invoker `Modal` records is whatever had focus when it opened. Focusing first is
 * what makes the test reflect the browser.
 */
function focusAndClick(element: HTMLElement): void {
  element.focus();
  fireEvent.click(element);
}

function closeButton(): HTMLElement {
  return screen.getByRole('button', { name: /close/i });
}

/** Mirrors real usage: the dialog is mounted by a trigger and unmounted on close. */
function Harness() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1}>
      <button
        onClick={() => {
          setIsOpen(true);
        }}
      >
        Invite agent
      </button>
      {isOpen ? (
        <Modal
          isOpen
          title="Invite an agent"
          onClose={() => {
            setIsOpen(false);
          }}
        >
          <TextInput name="email" aria-label="Email address" />
        </Modal>
      ) : null}
    </main>
  );
}

describe('Modal', () => {
  it('opens with an accessible name and focus on the first form control', () => {
    render(<Harness />);

    focusAndClick(screen.getByRole('button', { name: 'Invite agent' }));

    expect(screen.getByRole('dialog', { name: 'Invite an agent' })).toBeInTheDocument();
    // Not the close button, which is what `showModal()` would focus on its own.
    expect(screen.getByLabelText('Email address')).toHaveFocus();
  });

  it('restores focus to the invoker when it unmounts on close', () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Invite agent' });

    focusAndClick(trigger);
    fireEvent.click(closeButton());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape, through the dialog’s cancel event', () => {
    render(<Harness />);

    focusAndClick(screen.getByRole('button', { name: 'Invite agent' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite agent' })).toHaveFocus();
  });

  it('locks background scroll while open and releases it on close', () => {
    render(<Harness />);

    focusAndClick(screen.getByRole('button', { name: 'Invite agent' }));
    expect(document.body).toHaveAttribute('data-scroll-locked', 'true');

    fireEvent.click(closeButton());
    expect(document.body).not.toHaveAttribute('data-scroll-locked');
  });

  it('falls back to the main landmark when the invoker is gone by the time it closes', () => {
    /** Stands in for a row action whose row disappears once the action succeeds. */
    function VanishingTrigger() {
      const [state, setState] = useState<'idle' | 'open' | 'done'>('idle');

      return (
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          {state === 'idle' ? (
            <button
              onClick={() => {
                setState('open');
              }}
            >
              Remove Amina Haddad
            </button>
          ) : null}
          {state === 'open' ? (
            <Modal
              isOpen
              title="Remove agent"
              onClose={() => {
                setState('done');
              }}
            >
              <p>Confirm</p>
            </Modal>
          ) : null}
        </main>
      );
    }

    render(<VanishingTrigger />);

    focusAndClick(screen.getByRole('button', { name: 'Remove Amina Haddad' }));
    fireEvent.click(closeButton());

    expect(document.getElementById(MAIN_CONTENT_ID)).toHaveFocus();
  });
});

/**
 * Which dismissals a dialog accepts, and what it tells its caller about them
 * (0002 §1.4). The scrim rule is the one with a cost attached: a form dismissed
 * by a pointer landing a few pixels wide of the panel is the reader's work gone.
 */
describe('Modal dismissal', () => {
  function renderKind(kind: 'view' | 'form') {
    const onClose = vi.fn();

    render(
      <Modal isOpen kind={kind} title="Runs" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    );

    return { dialog: screen.getByRole('dialog'), onClose };
  }

  it('closes a view on a press outside the panel', () => {
    const { dialog, onClose } = renderKind('view');

    // The dialog element *is* the backdrop: a click whose target is the dialog
    // rather than its content landed outside the panel.
    fireEvent.click(dialog);

    expect(onClose).toHaveBeenCalledWith('scrim');
  });

  it('does not close a form on a press outside the panel', () => {
    const { dialog, onClose } = renderKind('form');

    fireEvent.click(dialog);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('never mistakes a press on the panel for one on the scrim', () => {
    const { onClose } = renderKind('view');

    fireEvent.click(screen.getByText('Body'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('tells the caller which dismissal it was', () => {
    const { dialog, onClose } = renderKind('view');

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledWith('escape');

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledWith('invoked');
  });
});
