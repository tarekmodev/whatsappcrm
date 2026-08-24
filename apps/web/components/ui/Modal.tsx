'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from './Button';
import { useContent } from '@/lib/content';
import { useScrollLock } from '@/lib/hooks/useScrollLock';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import styles from './Modal.module.css';

/**
 * The one dialog in the app. Usage:
 * `<Modal isOpen={…} onClose={…} title={…} footer={…}>…</Modal>`.
 *
 * Built on native `<dialog>` deliberately: `showModal()` provides the focus trap,
 * Escape-to-close, focus restoration to the invoker and an inert background for
 * free. Re-implementing those in JavaScript is where accessible dialogs usually
 * go wrong.
 *
 * On small screens it becomes a full-height sheet — see the module file.
 */

/**
 * Where a dismissal came from. `escape` and `scrim` are the two a reader can
 * reach *by accident*; `invoked` is a control that says so — the close button,
 * a footer's Cancel, a route change. `FormDialog` reads it to decide whether
 * unsaved input needs confirming, which is a question only the accidental ones
 * have to ask.
 */
export const MODAL_CLOSE_REASONS = ['escape', 'scrim', 'invoked'] as const;
export type ModalCloseReason = (typeof MODAL_CLOSE_REASONS)[number];

/**
 * What the dialog holds, which is what decides whether a press on the scrim
 * dismisses it (0002 §1.4). A **view** is something the reader is looking at and
 * a press outside it means "I am done looking"; a **form** holds work, and an
 * accidental click off a half-filled one is that work destroyed by a miss.
 */
export const MODAL_KINDS = ['view', 'form'] as const;
export type ModalKind = (typeof MODAL_KINDS)[number];

export interface ModalProps {
  isOpen: boolean;
  /**
   * Dismissal. The reason is there for callers that treat an accidental
   * dismissal differently from a deliberate one; ignoring it is fine and is what
   * a view dialog does.
   */
  onClose: (reason: ModalCloseReason) => void;
  title: string;
  children: ReactNode;
  /** Actions row. Rendered at the block end and stacked full-width on mobile. */
  footer?: ReactNode;
  description?: string;
  /** `form` withholds scrim-click dismissal. See `MODAL_KINDS`. */
  kind?: ModalKind;
}

/**
 * `showModal()` puts focus on the dialog's first focusable node, which is the close
 * button in the header — so a form opens with focus on "dismiss". React's
 * `autoFocus` cannot fix that: it calls `focus()` on mount, before the dialog is
 * open, and `showModal()` then takes focus back. Moving it here, after the open, is
 * the only ordering that works.
 */
function focusFirstControl(dialog: HTMLDialogElement): void {
  const control = dialog.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );

  control?.focus();
}

/**
 * Back to whatever opened the dialog. When that control is gone — a row's Remove
 * button, after the removal succeeded — focus the main landmark instead, so the
 * keyboard user resumes at the top of the content rather than at `<body>`, where
 * the next Tab would start from the browser chrome.
 */
function restoreFocus(invoker: HTMLElement | null): void {
  if (invoker !== null && invoker.isConnected) {
    invoker.focus();
    return;
  }

  document.getElementById(MAIN_CONTENT_ID)?.focus();
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  description,
  kind = 'view',
}: ModalProps) {
  const content = useContent();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const invokerRef = useRef<HTMLElement | null>(null);
  const lastPathnameRef = useRef<string | null>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const pathname = usePathname();

  onCloseRef.current = onClose;

  useScrollLock(isOpen);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (isOpen && !dialog.open) {
      // Remember the invoker before opening. The browser restores focus itself on
      // `close()`, but these dialogs *unmount* when dismissed, so that never runs —
      // and focus would land on `<body>`.
      const active = document.activeElement;

      // `<body>` is not an invoker: restoring "focus" to it is the very thing this
      // is here to avoid.
      invokerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
      dialog.showModal();
      focusFirstControl(dialog);
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Restores focus on close *and* on unmount, which is the same event here.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    return () => {
      restoreFocus(invokerRef.current);
    };
  }, [isOpen]);

  // A navigation that leaves the dialog mounted must still dismiss it.
  useEffect(() => {
    if (lastPathnameRef.current !== null && lastPathnameRef.current !== pathname) {
      onCloseRef.current('invoked');
    }

    lastPathnameRef.current = pathname;
  }, [pathname]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      // `cancel` fires for Escape. Preventing the default close and routing
      // through `onClose` keeps React's state the source of truth.
      onCancel={(event) => {
        event.preventDefault();
        onClose('escape');
      }}
      // The backdrop is the dialog element itself, outside the panel, so a click
      // landing on the dialog rather than on its content is a backdrop click.
      //
      // A form does not take it (0002 §1.4). The reader has nothing to lose by
      // pressing outside a view; pressing outside a half-filled form loses all
      // of it, and the miss that does it is a pointer landing a few pixels wide
      // of the panel. Escape and Cancel are still there and both say so out loud.
      onClick={(event) => {
        if (kind === 'view' && event.target === dialogRef.current) {
          onClose('scrim');
        }
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.headingGroup}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onClose('invoked');
            }}
            aria-label={content.common.close}
            className={styles.closeButton}
          >
            <span aria-hidden="true">✕</span>
          </Button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer === undefined ? null : <footer className={styles.footer}>{footer}</footer>}
      </div>
    </dialog>
  );
}
