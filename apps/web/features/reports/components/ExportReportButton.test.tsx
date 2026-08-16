import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiRequestError } from '@/lib/api/error';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { formatReportDate } from '@/features/reports/presentation';
import type { ReportParams } from '@/features/reports/report-params';
import { ExportReportButton } from './ExportReportButton';

/**
 * TAR-431's acceptance criteria at the control level.
 *
 * The first case is the one the story exists for: the request carries the range
 * and scope the page was rendered with, and nothing else. The rest are the states
 * a download has that a link cannot show — pending, refused, and refused twice
 * over because somebody pressed the button again.
 */

const downloadDashboardExport = vi.fn();

vi.mock('@/lib/api/reports-browser', () => ({
  downloadDashboardExport: (...args: unknown[]) => downloadDashboardExport(...args) as unknown,
}));

const PARAMS: ReportParams = { from: '2026-08-01', to: '2026-08-07', scope: 'all' };

const EXPORT_LABEL = content.reports.exportAria(
  formatReportDate(PARAMS.from, content),
  formatReportDate(PARAMS.to, content),
);

const FILE = { blob: new Blob(['from,to\r\n'], { type: 'text/csv' }), fileName: 'report.csv' };

function renderControl(params: ReportParams = PARAMS) {
  return render(
    <ToastProvider>
      <ExportReportButton params={params} />
    </ToastProvider>,
  );
}

function exportButton(): HTMLElement {
  return screen.getByRole('button', { name: EXPORT_LABEL });
}

/** Held locally as well as assigned, so assertions never unbind `URL`'s methods. */
const createObjectURL = vi.fn(() => 'blob:report');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  downloadDashboardExport.mockReset();
  downloadDashboardExport.mockResolvedValue(FILE);
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  // jsdom implements neither, and the download path is the thing under test.
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportReportButton', () => {
  it('exports the range and scope the page is showing, and nothing else', async () => {
    renderControl();

    fireEvent.click(exportButton());

    await waitFor(() => {
      expect(downloadDashboardExport).toHaveBeenCalledTimes(1);
    });

    // The whole of "a supervisor can never export a range different from what is
    // on screen": the query is the page's applied params plus the section.
    expect(downloadDashboardExport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-07', scope: 'all', section: 'agents' },
      expect.anything(),
    );
  });

  it('follows the screen when the applied range changes', async () => {
    const { rerender } = renderControl();

    rerender(
      <ToastProvider>
        <ExportReportButton params={{ from: '2026-01-01', to: '2026-01-31', scope: 'assigned' }} />
      </ToastProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: content.reports.exportAria(
          formatReportDate('2026-01-01', content),
          formatReportDate('2026-01-31', content),
        ),
      }),
    );

    await waitFor(() => {
      expect(downloadDashboardExport).toHaveBeenCalledWith(
        { from: '2026-01-01', to: '2026-01-31', scope: 'assigned', section: 'agents' },
        expect.anything(),
      );
    });
  });

  it('says it is preparing the file, then names the file that arrived', async () => {
    let settle: ((file: typeof FILE) => void) | undefined;

    downloadDashboardExport.mockReturnValue(
      new Promise<typeof FILE>((resolve) => {
        settle = resolve;
      }),
    );

    renderControl();
    fireEvent.click(exportButton());

    // "Saving…" would be wrong — nothing is being written.
    expect(await screen.findByText(content.reports.exportPending)).toBeInTheDocument();

    settle?.(FILE);

    expect(await screen.findByText(content.reports.exportReady(FILE.fileName))).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Revoked in the same turn, so a supervisor who exports all afternoon leaks
    // nothing.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
  });

  it('keeps a refusal on the page, with the reference support will ask for', async () => {
    downloadDashboardExport.mockRejectedValue(
      new ApiRequestError(403, 'forbidden', 'Missing permission report:read', 'req-42'),
    );

    renderControl();
    fireEvent.click(exportButton());

    const alert = await screen.findByRole('alert');

    // The API's own message is never shown; the copy names what the supervisor
    // can do about it.
    expect(alert).toHaveTextContent(content.reports.exportForbidden);
    expect(alert).toHaveTextContent(content.errors.correlationId('req-42'));
    expect(alert).not.toHaveTextContent('Missing permission');
  });

  it('names the range as the thing to change when the API refuses it', async () => {
    downloadDashboardExport.mockRejectedValue(
      new ApiRequestError(400, 'validation_failed', 'Range must not exceed 366 days', null),
    );

    renderControl();
    fireEvent.click(exportButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(content.reports.exportRangeRefused);
  });

  it('retries on the next press, and clears the failure when it works', async () => {
    downloadDashboardExport.mockRejectedValueOnce(
      new ApiRequestError(500, 'internal_error', 'boom', null),
    );

    renderControl();
    fireEvent.click(exportButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(content.reports.exportFailed);

    fireEvent.click(exportButton());

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(downloadDashboardExport).toHaveBeenCalledTimes(2);
  });

  it('exports once when the button is double-clicked', () => {
    downloadDashboardExport.mockReturnValue(new Promise(() => undefined));

    renderControl();

    const button = exportButton();

    fireEvent.click(button);
    fireEvent.click(button);

    expect(downloadDashboardExport).toHaveBeenCalledTimes(1);
  });

  it('aborts the request rather than leaving it running when the page goes', () => {
    let signal: AbortSignal | undefined;

    downloadDashboardExport.mockImplementation((_query: unknown, abortSignal: AbortSignal) => {
      signal = abortSignal;

      return new Promise(() => undefined);
    });

    const { unmount } = renderControl();

    fireEvent.click(exportButton());
    unmount();

    expect(signal?.aborted).toBe(true);
  });
});
