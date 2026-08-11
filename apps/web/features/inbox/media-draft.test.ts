import { describe, expect, it } from 'vitest';
import { WHATSAPP_MEDIA_LIMITS } from '@whatsappcrm/contracts';
import { ATTACHABLE_MEDIA_KINDS, checkMediaFile, mediaAcceptAttribute } from './media-draft';

const ONE_KILOBYTE = 1024;

describe('checkMediaFile', () => {
  it('accepts a file WhatsApp carries, and names its kind', () => {
    expect(
      checkMediaFile({ type: 'image/png', size: ONE_KILOBYTE }, ATTACHABLE_MEDIA_KINDS),
    ).toEqual({ outcome: 'accepted', kind: 'image' });
  });

  it('ignores the media type’s parameters', () => {
    // A browser that helpfully sends a charset should not be told its file is
    // unsupported.
    expect(
      checkMediaFile(
        { type: 'Text/Plain; charset=utf-8', size: ONE_KILOBYTE },
        ATTACHABLE_MEDIA_KINDS,
      ),
    ).toEqual({ outcome: 'accepted', kind: 'document' });
  });

  it('refuses a type WhatsApp carries in no message at all', () => {
    expect(
      checkMediaFile({ type: 'image/gif', size: ONE_KILOBYTE }, ATTACHABLE_MEDIA_KINDS),
    ).toEqual({ outcome: 'unsupported-type' });
  });

  it('refuses a sticker, which is inbound-only', () => {
    // Sending one needs a sticker pack registered with Meta, which this product
    // does not model — accepting the upload would be a dead end with a media id.
    expect(
      checkMediaFile({ type: 'image/webp', size: ONE_KILOBYTE }, ATTACHABLE_MEDIA_KINDS),
    ).toEqual({ outcome: 'unsupported-type' });
  });

  it('refuses a supported type in a slot that does not take it', () => {
    // A template approved with an IMAGE header, offered a PDF. Refused here
    // rather than at Meta, where the error names neither the template nor the
    // upload.
    expect(checkMediaFile({ type: 'application/pdf', size: ONE_KILOBYTE }, ['image'])).toEqual({
      outcome: 'unsupported-type',
    });
  });

  it('refuses a file over its kind’s ceiling, before the upload is spent', () => {
    const { maxBytes } = WHATSAPP_MEDIA_LIMITS.image;

    expect(
      checkMediaFile({ type: 'image/jpeg', size: maxBytes + 1 }, ATTACHABLE_MEDIA_KINDS),
    ).toEqual({ outcome: 'too-large', kind: 'image', maxBytes });
  });

  it('accepts a file exactly on the ceiling', () => {
    expect(
      checkMediaFile(
        { type: 'image/jpeg', size: WHATSAPP_MEDIA_LIMITS.image.maxBytes },
        ATTACHABLE_MEDIA_KINDS,
      ),
    ).toEqual({ outcome: 'accepted', kind: 'image' });
  });

  it('applies the ceiling of the kind, not one global number', () => {
    // 20 MB is over the image limit and under the document one; a single flat
    // cap would get one of the two wrong.
    const size = 20 * ONE_KILOBYTE * ONE_KILOBYTE;

    expect(checkMediaFile({ type: 'image/png', size }, ATTACHABLE_MEDIA_KINDS).outcome).toBe(
      'too-large',
    );
    expect(checkMediaFile({ type: 'application/pdf', size }, ATTACHABLE_MEDIA_KINDS).outcome).toBe(
      'accepted',
    );
  });
});

describe('mediaAcceptAttribute', () => {
  it('lists exactly the media types the allowed kinds permit', () => {
    expect(mediaAcceptAttribute(['image'])).toBe('image/jpeg,image/png');
  });

  it('never offers a kind the slot does not take', () => {
    expect(mediaAcceptAttribute(ATTACHABLE_MEDIA_KINDS)).not.toContain('image/webp');
  });
});
