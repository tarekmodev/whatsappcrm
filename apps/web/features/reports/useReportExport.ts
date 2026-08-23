'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReportExportSection } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import { downloadDashboardExport, type DashboardExportFile } from '@/lib/api/reports-browser';
import type { ReportParams } from '@/features/reports/report-params';

/**
 * Fetch the CSV for the range that is on screen, and hand it to the browser as a
 * download. Usage:
 *
 * ```tsx
 * const { exportReport, isExporting, exportError, requestId } = useReportExport({
 *   params,
 *   onExported: (fileName) => { showToast({ tone: 'success', message: … }); },
 * });
 * ```
 *
 * `params` is the applied query the page parsed out of the URL — the same value
 * the metrics read was built from. That is TAR-431's first criterion rather than
 * an implementation detail: this hook holds no filters of its own and has nowhere
 * to put any, and the query is rebuilt from `params` on every call, so the
 * request cannot be one navigation behind the screen.
 *
 * Three things it owns, because a button that did the fetch inline would get one
 * of them wrong:
 *
 *   * **No double export.** A ref rather than the state flag: two clicks in one
 *     tick would both read `isExporting === false`.
 *   * **The failure is a message, not a navigation.** Fetching is what makes that
 *     possible (see `reports-browser.ts`); mapping the code to copy is here so
 *     every caller reports the same failure the same way.
 *   * **Nothing lands after unmount.** The request is aborted and a late
 *     resolution writes no state — leaving the dashboard for the inbox mid-export
 *     is an ordinary thing to do.
 */

export interface UseReportExportOptions {
  params: ReportParams;
  /**
   * Which CSV. The contract's default is the per-agent table — ADR 0010
   * (reporting dashboard and export) decision 7.
   */
  section?: ReportExportSection;
  /** Called with the saved file name, for the success toast. */
  onExported: (fileName: string) => void;
}

export interface UseReportExport {
  /** Returns `false` when the guard swallowed it because one is already in flight. */
  exportReport: () => boolean;
  isExporting: boolean;
  exportError: string | null;
  requestId: string | null;
}

export function useReportExport({
  params,
  section = 'agents',
  onExported,
}: UseReportExportOptions): UseReportExport {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const exportReport = useCallback((): boolean => {
    if (inFlightRef.current) {
      return false;
    }

    const controller = new AbortController();

    inFlightRef.current = true;
    abortRef.current = controller;
    setIsExporting(true);
    setExportError(null);
    setRequestId(null);

    void downloadDashboardExport({ ...params, section }, controller.signal)
      .then((file) => {
        if (!isMountedRef.current) {
          return;
        }

        saveFile(file);
        onExported(file.fileName);
      })
      .catch((error: unknown) => {
        // An abort is the component going away, not a failure.
        if (controller.signal.aborted) {
          return;
        }

        // Never swallowed: the reason belongs in the log, a readable line on
        // screen.
        console.error('Report export failed', error);

        if (!isMountedRef.current) {
          return;
        }

        const failure = exportFailure(error);

        setExportError(failure.message);
        setRequestId(failure.requestId);
      })
      .finally(() => {
        inFlightRef.current = false;

        if (isMountedRef.current) {
          setIsExporting(false);
        }
      });

    return true;
  }, [onExported, params, section]);

  return { exportReport, isExporting, exportError, requestId };
}

/**
 * A synthetic anchor rather than `window.location`, so the browser treats it as a
 * download with a name rather than a navigation, and the page the supervisor is
 * reading stays where it is.
 *
 * The object URL is revoked in the same turn: the browser has taken its reference
 * by the time `click()` returns, and a timer left to revoke it later is a leak
 * whenever the page unmounts first.
 */
function saveFile({ blob, fileName }: DashboardExportFile): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  // Appended before the click: a detached anchor is not clickable in every
  // browser, and removed straight after so nothing is left in the document.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

interface ExportFailure {
  message: string;
  requestId: string | null;
}

/**
 * What the supervisor is told. Never the API's own message: that one is written
 * for whoever is reading the log, and envelope text on screen tells the person
 * holding the mouse nothing they can act on. The `requestId` is carried so
 * support can find the request that failed.
 */
function exportFailure(error: unknown): ExportFailure {
  if (!(error instanceof ApiRequestError)) {
    return { message: content.reports.exportFailed, requestId: null };
  }

  if (error.code === FORBIDDEN_CODE) {
    return { message: content.reports.exportForbidden, requestId: error.requestId };
  }

  // The range in the URL is checked against the contract before it is sent, so
  // reaching this means the API refused a range the screen thought was fine —
  // and a shorter one is the thing the supervisor can actually do about it.
  if (error.code === VALIDATION_FAILED_CODE) {
    return { message: content.reports.exportRangeRefused, requestId: error.requestId };
  }

  return { message: content.reports.exportFailed, requestId: error.requestId };
}

const FORBIDDEN_CODE = 'forbidden';
const VALIDATION_FAILED_CODE = 'validation_failed';
