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

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Actions row. Rendered at the block end and stacked full-width on mobile. */
  footer?: ReactNode;
  description?: string;
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

export function Modal({ isOpen, onClose, title, children, footer, description }: ModalProps) {
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
      onCloseRef.current();
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
        onClose();
      }}
      // The backdrop is the dialog element itself, outside the panel, so a click
      // landing on the dialog rather than on its content is a backdrop click.
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
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
            onClick={onClose}
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
