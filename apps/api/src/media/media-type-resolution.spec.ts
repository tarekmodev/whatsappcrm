import { WHATSAPP_MEDIA_LIMITS } from '@whatsappcrm/contracts';
import {
  MediaContentMismatchError,
  MediaTooLargeError,
  UnsupportedMediaTypeError,
} from './media.errors';
import { assertWithinMediaLimit, resolveUploadedMediaType } from './media-type-resolution';

function head(...magic: (number | string)[]): Buffer {
  const bytes = magic.flatMap((part) =>
    typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : [part],
  );

  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]).subarray(0, 32);
}

const JPEG = head(0xff, 0xd8, 0xff, 0xe0);
const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = head('%PDF-1.7');
const WEBP = head('RIFF', 0x24, 0x00, 0x00, 0x00, 'WEBP');
const MP4 = head(0x00, 0x00, 0x00, 0x20, 'ftyp', 'isom');

describe('resolveUploadedMediaType', () => {
  it('trusts a declared type once the bytes agree with it', () => {
    expect(resolveUploadedMediaType('image/jpeg', JPEG)).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('falls back to the bytes when the client could not name the type', () => {
    // The common honest case: a plain file input, and a browser that guessed.
    expect(resolveUploadedMediaType('application/octet-stream', PDF)).toEqual({
      kind: 'document',
      mimeType: 'application/pdf',
    });
  });

  it('refuses a file whose bytes contradict its declared type', () => {
    expect(() => resolveUploadedMediaType('application/pdf', PNG)).toThrow(
      MediaContentMismatchError,
    );
  });

  it('refuses a type WhatsApp does not carry', () => {
    // A GIF is a real image and not one the Cloud API accepts.
    expect(() => resolveUploadedMediaType('image/gif', head(0x47, 0x49, 0x46, 0x38))).toThrow(
      UnsupportedMediaTypeError,
    );
  });

  it('refuses a sticker, which is inbound-only', () => {
    // WebP is stored — an inbound sticker is — but a `mediaId` for one could
    // never be sent, so the upload is refused rather than becoming a dead end.
    expect(() => resolveUploadedMediaType('image/webp', WEBP)).toThrow(UnsupportedMediaTypeError);
  });

  it('names the declared type in the refusal, not the detected one', () => {
    // The declared type is what the caller sent and can change.
    expect(() => resolveUploadedMediaType('application/x-msdownload', head('MZ', 0x90))).toThrow(
      /application\/x-msdownload/,
    );
  });

  it('refuses unrecognisable bytes under an unrecognised declaration', () => {
    expect(() =>
      resolveUploadedMediaType('application/octet-stream', head(0x01, 0x02, 0x03)),
    ).toThrow(UnsupportedMediaTypeError);
  });

  it('resolves a video to `video`, which has its own ceiling', () => {
    expect(resolveUploadedMediaType('video/mp4', MP4)).toEqual({
      kind: 'video',
      mimeType: 'video/mp4',
    });
  });
});

describe('assertWithinMediaLimit', () => {
  it('accepts a file at the ceiling', () => {
    expect(() =>
      assertWithinMediaLimit('image', WHATSAPP_MEDIA_LIMITS.image.maxBytes),
    ).not.toThrow();
  });

  it('refuses a file one byte over', () => {
    expect(() => assertWithinMediaLimit('image', WHATSAPP_MEDIA_LIMITS.image.maxBytes + 1)).toThrow(
      MediaTooLargeError,
    );
  });

  it('applies the ceiling of the resolved kind, not the largest one', () => {
    // The reason resolution comes first: a 40 MB file is a legal document and
    // an illegal image, and a single cap could not say both.
    const fortyMegabytes = 40 * 1_024 * 1_024;

    expect(() => assertWithinMediaLimit('document', fortyMegabytes)).not.toThrow();
    expect(() => assertWithinMediaLimit('image', fortyMegabytes)).toThrow(MediaTooLargeError);
  });

  it('quotes the ceiling it applied', () => {
    expect(() => assertWithinMediaLimit('image', Number.MAX_SAFE_INTEGER)).toThrow(/5120 KB/);
  });
});
