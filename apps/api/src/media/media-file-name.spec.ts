import { contentDispositionFor, sanitiseFileName } from './media-file-name';

describe('sanitiseFileName', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitiseFileName('Invoice 2026-08.pdf')).toBe('Invoice 2026-08.pdf');
  });

  it('keeps only the leaf of a path', () => {
    expect(sanitiseFileName('/etc/passwd')).toBe('passwd');
    expect(sanitiseFileName('C:\\Windows\\System32\\config')).toBe('config');
    expect(sanitiseFileName('../../secrets.env')).toBe('secrets.env');
  });

  it('strips the control characters that would split a header', () => {
    expect(sanitiseFileName('invoice.pdf\r\nX-Injected: yes')).toBe('invoice.pdfX-Injected: yes');
  });

  it('refuses to leave a name that is only dots', () => {
    expect(sanitiseFileName('..')).toBeNull();
    expect(sanitiseFileName('../')).toBeNull();
    expect(sanitiseFileName('   ')).toBeNull();
    expect(sanitiseFileName('')).toBeNull();
  });

  it('returns null rather than inventing a name', () => {
    expect(sanitiseFileName(undefined)).toBeNull();
    expect(sanitiseFileName(null)).toBeNull();
  });

  it('bounds the length', () => {
    expect(sanitiseFileName('a'.repeat(400))).toHaveLength(255);
  });

  it('keeps non-ASCII names, which are ordinary names', () => {
    expect(sanitiseFileName('فاتورة.pdf')).toBe('فاتورة.pdf');
  });
});

describe('contentDispositionFor', () => {
  it('always says attachment, so nothing is rendered on this origin', () => {
    expect(contentDispositionFor(null)).toBe('attachment');
    expect(contentDispositionFor('report.pdf')).toMatch(/^attachment;/);
  });

  it('carries both an ASCII fallback and the UTF-8 form', () => {
    expect(contentDispositionFor('فاتورة.pdf')).toBe(
      'attachment; filename="______.pdf"; filename*=UTF-8\'\'%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9.pdf',
    );
  });

  it('cannot be closed early by a quote in the name', () => {
    const header = contentDispositionFor('a".pdf');

    expect(header).toBe('attachment; filename="a_.pdf"; filename*=UTF-8\'\'a%22.pdf');
    // One opening and one closing quote: the value is still a single token.
    expect(header.split('"')).toHaveLength(3);
  });
});
