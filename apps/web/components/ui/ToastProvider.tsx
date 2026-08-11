'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from './Button';
import { useContent } from '@/lib/content';
import styles from './ToastProvider.module.css';

/**
 * The one notification system in the app. Usage:
 *
 * ```tsx
 * const { showToast } = useToast();
 * showToast({ tone: 'success', message: content.people.inviteSuccess(email) });
 * ```
 *
 * A toast is never the only place a failure is reported — form errors also render
 * inline next to the field. Announced through a polite live region, positioned
 * clear of the primary actions and safe-area aware on mobile.
 */

export const TOAST_TONES = ['success', 'danger', 'info'] as const;
export type ToastTone = (typeof TOAST_TONES)[number];

export interface ToastInput {
  message: string;
  tone?: ToastTone;
}

interface Toast extends ToastInput {
  id: string;
  tone: ToastTone;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const content = useContent();
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);

    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    ({ message, tone = 'info' }: ToastInput) => {
      nextIdRef.current += 1;
      const id = `toast-${String(nextIdRef.current)}`;

      setToasts((current) => [...current, { id, message, tone }]);

      // Cleared in `dismiss`, so a manual dismissal leaves no orphaned timer.
      timersRef.current.set(
        id,
        setTimeout(() => {
          dismiss(id);
        }, TOAST_DURATION_MS),
      );
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className={styles.region}
        role="region"
        aria-label={content.common.notifications}
        // Polite, so a toast never interrupts what the user is reading, and never
        // steals focus from the form that produced it.
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div key={toast.id} className={styles.toast} data-tone={toast.tone}>
            <p className={styles.message}>{toast.message}</p>
            <Button
              variant="ghost"
              size="sm"
              aria-label={content.common.dismiss}
              onClick={() => {
                dismiss(toast.id);
              }}
            >
              <span aria-hidden="true">✕</span>
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);

  if (value === null) {
    throw new Error('useToast must be used inside a ToastProvider.');
  }

  return value;
}
