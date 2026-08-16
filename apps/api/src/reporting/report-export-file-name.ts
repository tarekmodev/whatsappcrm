import type { DashboardExportQuery } from '@whatsappcrm/contracts';

/**
 * What the downloaded report is called, and the `Content-Disposition` that
 * carries it (ADR 0009 decision 7).
 *
 * `report-<section>-<from>-<to>.csv`, so a supervisor who exports four ranges
 * in a morning ends up with four distinguishable files in their downloads
 * folder rather than `report (3).csv`. The order — section first, then the
 * range — is what makes the folder sort usefully.
 *
 * ## Why this needs no sanitising, and why it says so
 *
 * `media-file-name.ts` exists because an upload's name is user input that
 * reaches a header. Nothing here is: `section` is an enum from the contract and
 * both dates have been parsed by `ReportDateSchema` before a handler sees them,
 * so every character in the result comes from `[a-z0-9-]`. The assertion below
 * is what keeps that true — a future filter spliced into the name (a team
 * slug, say) would fail it rather than silently reopening header injection.
 */

/** Section, then the range, then the extension — all of it ASCII by construction. */
const SAFE_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.csv$/;

export function reportExportFileName(query: DashboardExportQuery): string {
  const name = `report-${query.section}-${query.from}-${query.to}.csv`;

  if (!SAFE_FILE_NAME.test(name)) {
    // Unreachable with the current contract, and deliberately not a silent
    // fallback: a name that fails this has picked up input from somewhere the
    // schema does not validate, and quietly renaming the download would hide
    // that instead of stopping it.
    throw new Error('The report file name contains characters no report parameter can produce.');
  }

  return name;
}

/**
 * `attachment`, never `inline`, matching `MediaController.content`. Together
 * with `X-Content-Type-Options: nosniff` it is what stops a browser deciding
 * the download is a page and running it on the API origin.
 *
 * One `filename` form rather than the RFC 6266 pair the media route emits: that
 * route needs `filename*` because a stored file's name can be any UTF-8 a
 * customer chose, and this one cannot contain a non-ASCII character at all.
 */
export function reportContentDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}
