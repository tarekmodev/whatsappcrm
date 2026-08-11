import { isContentConsistentWithDeclaredType, sniffContentType } from './content-type-sniffer';

/**
 * The signature check, which is the difference between "the client says it is a
 * PDF" and "it is a PDF". Two things are asserted: that every accepted format
 * is recognised — a false rejection here makes a legitimate upload impossible —
 * and that a mislabelled file is caught, which is the security property.
 */

/** A head buffer starting with `magic`, padded so offset-based signatures fit. */
function head(...magic: (number | string)[]): Buffer {
  const bytes = magic.flatMap((part) =>
    typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : [part],
  );

  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]).subarray(0, 32);
}

const JPEG = head(0xff, 0xd8, 0xff, 0xe0);
const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = head('RIFF', 0x24, 0x00, 0x00, 0x00, 'WEBP');
const PDF = head('%PDF-1.7');
const OGG = head('OggS');
const MP3 = head('ID3', 0x04);
const AAC = head(0xff, 0xf1, 0x50);
const AMR = head('#!AMR\n');
const MP4 = head(0x00, 0x00, 0x00, 0x20, 'ftyp', 'isom');
const THREE_GP = head(0x00, 0x00, 0x00, 0x18, 'ftyp', '3gp4');
const M4A = head(0x00, 0x00, 0x00, 0x20, 'ftyp', 'M4A ');
const ZIP = head(0x50, 0x4b, 0x03, 0x04);
const OLE = head(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const TEXT = Buffer.from('Dear customer,\r\n\tyour invoice is attached.', 'utf8');

describe('sniffContentType', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['WebP', WEBP, 'image/webp'],
    ['PDF', PDF, 'application/pdf'],
    ['Ogg', OGG, 'application/ogg'],
    ['ID3-tagged MP3', MP3, 'audio/mpeg'],
    ['ADTS AAC', AAC, 'audio/aac'],
    ['AMR', AMR, 'audio/amr'],
    ['MP4', MP4, 'video/mp4'],
    ['3GP', THREE_GP, 'video/3gpp'],
    ['M4A', M4A, 'audio/mp4'],
    ['ZIP container', ZIP, 'application/zip'],
    ['OLE2 compound file', OLE, 'application/x-ole-storage'],
  ])('recognises %s', (_name, bytes, expected) => {
    expect(sniffContentType(bytes)).toBe(expected);
  });

  it('recognises nothing in plain text, which has no signature', () => {
    expect(sniffContentType(TEXT)).toBeNull();
  });

  it('does not read past the end of a very short file', () => {
    // A two-byte file must not be padded into a match. `FF D8` alone is not a
    // JPEG — the third byte is part of the signature.
    expect(sniffContentType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });

  it('tells an M4A from an MP4 by the brand, not by the ftyp box', () => {
    expect(sniffContentType(M4A)).toBe('audio/mp4');
    expect(sniffContentType(MP4)).toBe('video/mp4');
  });
});

describe('isContentConsistentWithDeclaredType', () => {
  it('accepts bytes that match what was declared', () => {
    expect(isContentConsistentWithDeclaredType(JPEG, 'image/jpeg')).toBe(true);
    expect(isContentConsistentWithDeclaredType(PDF, 'application/pdf')).toBe(true);
  });

  it('ignores media-type parameters and casing', () => {
    expect(isContentConsistentWithDeclaredType(PNG, 'Image/PNG')).toBe(true);
    expect(isContentConsistentWithDeclaredType(TEXT, 'text/plain; charset=utf-8')).toBe(true);
  });

  it('refuses a JPEG declared as a PDF', () => {
    // The declaration is what the recipient's client renders by, so a mismatch
    // is a defect however it arose.
    expect(isContentConsistentWithDeclaredType(JPEG, 'application/pdf')).toBe(false);
  });

  it('refuses an executable declared as an image', () => {
    const windowsExecutable = head('MZ', 0x90, 0x00);

    expect(isContentConsistentWithDeclaredType(windowsExecutable, 'image/png')).toBe(false);
  });

  it('accepts an OOXML document, which is legitimately a ZIP', () => {
    expect(
      isContentConsistentWithDeclaredType(
        ZIP,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
  });

  it('refuses a bare ZIP declared as a PDF', () => {
    // The ZIP leniency is scoped to the three OOXML types and no further.
    expect(isContentConsistentWithDeclaredType(ZIP, 'application/pdf')).toBe(false);
  });

  it('accepts a legacy Word document, which is an OLE2 container', () => {
    expect(isContentConsistentWithDeclaredType(OLE, 'application/msword')).toBe(true);
    expect(isContentConsistentWithDeclaredType(OLE, 'application/pdf')).toBe(false);
  });

  it('accepts an Ogg voice note declared the way WhatsApp names it', () => {
    // The container says `application/ogg`; Meta says `audio/ogg`.
    expect(isContentConsistentWithDeclaredType(OGG, 'audio/ogg')).toBe(true);
  });

  it('accepts either MP4 arm for an MP4 container', () => {
    expect(isContentConsistentWithDeclaredType(M4A, 'video/mp4')).toBe(true);
    expect(isContentConsistentWithDeclaredType(MP4, 'audio/mp4')).toBe(true);
  });

  it('refuses binary declared as plain text', () => {
    expect(isContentConsistentWithDeclaredType(PNG, 'text/plain')).toBe(false);
    expect(isContentConsistentWithDeclaredType(Buffer.from([0x41, 0x00, 0x42]), 'text/plain')).toBe(
      false,
    );
  });

  it('accepts non-ASCII text, which is text', () => {
    expect(isContentConsistentWithDeclaredType(Buffer.from('فاتورة', 'utf8'), 'text/plain')).toBe(
      true,
    );
  });
});
