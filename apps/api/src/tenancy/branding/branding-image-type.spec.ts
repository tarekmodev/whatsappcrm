import { BRANDING_ASSET_LIMITS } from '@whatsappcrm/contracts';
import { BRANDING_SNIFF_BYTES, sniffBrandingImageType } from './branding-image-type';

/**
 * The upload's declared `Content-Type` is attacker-controlled and is never
 * consulted; these bytes are what decides both whether an upload is accepted and
 * what the serve route later sets as the response's own `Content-Type`.
 */

const head = (...bytes: number[]): Buffer =>
  Buffer.concat([Buffer.from(bytes), Buffer.alloc(BRANDING_SNIFF_BYTES)]).subarray(
    0,
    BRANDING_SNIFF_BYTES,
  );

const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = head(0xff, 0xd8, 0xff, 0xe0);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);
const ICO = head(0x00, 0x00, 0x01, 0x00);

describe('sniffBrandingImageType', () => {
  it.each([
    ['a PNG', PNG, 'image/png'],
    ['a JPEG', JPEG, 'image/jpeg'],
    ['a WebP', WEBP, 'image/webp'],
    ['an ICO', ICO, 'image/x-icon'],
  ])('recognises %s', (_label, bytes, expected) => {
    expect(sniffBrandingImageType(bytes)).toBe(expected);
  });

  it('refuses an SVG, whatever it says it is', () => {
    // An SVG served same-origin executes script, and a sanitiser is a security
    // dependency to own forever. It is not in the allow-list, so it must not be
    // recognisable either.
    expect(sniffBrandingImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
      null,
    );
  });

  it('refuses HTML dressed as an image', () => {
    expect(sniffBrandingImageType(Buffer.from('<!DOCTYPE html><script>alert(1)</script>'))).toBe(
      null,
    );
  });

  it('refuses a cursor, which shares the ICO container', () => {
    // Image type 2 rather than 1. The four bytes are compared exactly for this
    // reason — a two-byte prefix would accept it.
    expect(sniffBrandingImageType(head(0x00, 0x00, 0x02, 0x00))).toBe(null);
  });

  it('refuses a RIFF container that is not WebP', () => {
    const wave = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE'),
    ]);

    expect(sniffBrandingImageType(wave)).toBe(null);
  });

  it('refuses a file too short to carry any signature', () => {
    expect(sniffBrandingImageType(Buffer.from([0x89]))).toBe(null);
    expect(sniffBrandingImageType(Buffer.alloc(0))).toBe(null);
  });

  it('recognises every type the published limits accept, and nothing else', () => {
    // The allow-list and the signature table are two lists that have to agree:
    // a type in the contract with no signature here is an upload that can never
    // succeed, and the reverse is a format accepted by nobody's decision.
    const accepted = new Set(
      Object.values(BRANDING_ASSET_LIMITS).flatMap((limit) => [...limit.mimeTypes]),
    );
    const recognised = [PNG, JPEG, WEBP, ICO].map((bytes) => sniffBrandingImageType(bytes));

    expect(new Set(recognised)).toEqual(accepted);
  });
});
