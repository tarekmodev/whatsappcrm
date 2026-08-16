import type { DashboardExportQuery } from '@whatsappcrm/contracts';
import { reportContentDisposition, reportExportFileName } from './report-export-file-name';

const QUERY: DashboardExportQuery = {
  from: '2026-08-01',
  to: '2026-08-07',
  scope: 'all',
  section: 'agents',
};

describe('reportExportFileName', () => {
  it('names the section and the range, so four exports in a morning are four distinct files', () => {
    expect(reportExportFileName(QUERY)).toBe('report-agents-2026-08-01-2026-08-07.csv');
  });

  it.each(['summary', 'agents', 'series'] as const)('names the %s section', (section) => {
    expect(reportExportFileName({ ...QUERY, section })).toBe(
      `report-${section}-2026-08-01-2026-08-07.csv`,
    );
  });

  it('refuses a name no report parameter could have produced', () => {
    // Unreachable through the schema — both dates are parsed by
    // `ReportDateSchema` before a handler sees them. Asserted anyway, because
    // this is the check that stops a filter spliced into the name later from
    // silently reopening header injection on the download.
    expect(() => reportExportFileName({ ...QUERY, to: '2026-08-07"; drop' })).toThrow(
      /file name contains characters/,
    );
  });
});

describe('reportContentDisposition', () => {
  it('is an attachment, never inline', () => {
    expect(reportContentDisposition('report-agents-2026-08-01-2026-08-07.csv')).toBe(
      'attachment; filename="report-agents-2026-08-01-2026-08-07.csv"',
    );
  });
});
