'use client';

import { useCallback, useId } from 'react';
import type { ReportExportSection } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import { formatReportDate } from '@/features/reports/presentation';
import { useReportExport } from '@/features/reports/useReportExport';
import type { ReportParams } from '@/features/reports/report-params';
import styles from './ExportReportButton.module.css';

/**
 * Takes the dashboard away as a CSV. Usage:
 * `<ExportReportButton params={query} />` from the reports page header.
 *
 * **It takes the applied query and nothing else**, which is TAR-431's central
 * requirement rather than an implementation detail: there is no date field on
 * this control, no remembered range and no "export everything" escape hatch. The
 * only parameters it can send are the ones the page read out of the URL and is
 * rendering below, so a supervisor cannot export a window different from the one
 * they are looking at without first changing the screen.
 *
 * The range is in the accessible name and the hint is on screen for the same
 * reason: a button reading "Export CSV" says nothing about what is in the file.
 */

export interface ExportReportButtonProps {
  params: ReportParams;
  /** Which CSV; the contract's default is the per-agent table with its TOTAL row. */
  section?: ReportExportSection;
}

export function ExportReportButton({ params, section }: ExportReportButtonProps) {
  const content = useContent();
  const { showToast } = useToast();
  const hintId = useId();

  const onExported = useCallback(
    (fileName: string) => {
      showToast({ tone: 'success', message: content.reports.exportReady(fileName) });
    },
    [content.reports, showToast],
  );

  const { exportReport, isExporting, exportError, requestId } = useReportExport({
    params,
    section,
    onExported,
  });

  return (
    <Stack gap="2" className={styles.control}>
      <Button
        variant="secondary"
        isPending={isExporting}
        pendingLabel={content.reports.exportPending}
        aria-label={content.reports.exportAria(
          formatReportDate(params.from, content),
          formatReportDate(params.to, content),
        )}
        aria-describedby={hintId}
        onClick={() => {
          exportReport();
        }}
      >
        {content.reports.exportAction}
      </Button>
      <p className={styles.hint} id={hintId}>
        {content.reports.exportHint}
      </p>
      {/*
        Inline and beside the control, not only in a toast: a toast is gone in six
        seconds, and this is where the supervisor is already looking. The
        `requestId` goes with it so support can find the request that failed.
      */}
      <FormError message={exportError} requestId={requestId} />
    </Stack>
  );
}
