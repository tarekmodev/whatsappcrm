import { describe, expect, it } from 'vitest';
import { SendMessageInputSchema } from '@whatsappcrm/contracts';
import { MEDIA_CAPTION_MAX_LENGTH, MESSAGE_BODY_MAX_LENGTH } from './constants';
import { buildFreeFormSend, freeFormMaxLength } from './free-form-draft';
import { EMPTY_ATTACHMENT, type ComposerAttachmentValue } from './media-draft';

const READY: ComposerAttachmentValue = {
  status: 'ready',
  mediaId: '0192f00a-0000-7000-8000-000000000a01',
  fileName: 'statement.pdf',
  kind: 'document',
};

describe('freeFormMaxLength', () => {
  it('is the message ceiling with no file', () => {
    expect(freeFormMaxLength(EMPTY_ATTACHMENT)).toBe(MESSAGE_BODY_MAX_LENGTH);
  });

  it('drops to the caption ceiling once a file is attached', () => {
    // 4096 in a message, 1024 in a caption. Letting somebody write 2000
    // characters and discover the difference on submit is the bug.
    expect(freeFormMaxLength(READY)).toBe(MEDIA_CAPTION_MAX_LENGTH);
    expect(MEDIA_CAPTION_MAX_LENGTH).toBeLessThan(MESSAGE_BODY_MAX_LENGTH);
  });
});

describe('buildFreeFormSend', () => {
  it('builds a trimmed text send', () => {
    const build = buildFreeFormSend('  On its way.  ', EMPTY_ATTACHMENT);

    expect(build).toEqual({ outcome: 'ready', input: { type: 'text', body: 'On its way.' } });
    expect(
      SendMessageInputSchema.safeParse(build.outcome === 'ready' ? build.input : null).success,
    ).toBe(true);
  });

  it('builds a media send named by the file’s own kind, with the text as its caption', () => {
    const build = buildFreeFormSend('July statement.', READY);

    expect(build).toEqual({
      outcome: 'ready',
      input: { type: 'document', mediaId: READY.mediaId, caption: 'July statement.' },
    });
  });

  it('omits an empty caption rather than sending a blank line under the file', () => {
    const build = buildFreeFormSend('   ', READY);

    expect(build.outcome === 'ready' && 'caption' in build.input).toBe(false);
  });

  it('refuses an empty message with nothing attached', () => {
    expect(buildFreeFormSend('   ', EMPTY_ATTACHMENT)).toEqual({
      outcome: 'incomplete',
      problem: 'body-required',
    });
  });

  it('applies the message ceiling with no file, and the caption ceiling with one', () => {
    const between = 'x'.repeat(MEDIA_CAPTION_MAX_LENGTH + 1);

    expect(buildFreeFormSend(between, EMPTY_ATTACHMENT).outcome).toBe('ready');
    expect(buildFreeFormSend(between, READY)).toEqual({
      outcome: 'incomplete',
      problem: 'body-too-long',
    });
  });

  it('refuses the send while the upload is still in flight', () => {
    expect(
      buildFreeFormSend('Here you go', { status: 'uploading', fileName: 'statement.pdf' }),
    ).toEqual({ outcome: 'incomplete', problem: 'attachment-uploading' });
  });

  it('refuses the send rather than quietly dropping a file that failed to upload', () => {
    // The agent believes the message carries it. Sending the text alone would
    // be a reply that looks complete and is not.
    expect(
      buildFreeFormSend('Here you go', {
        status: 'failed',
        fileName: 'statement.pdf',
        message: 'nope',
      }),
    ).toEqual({ outcome: 'incomplete', problem: 'attachment-failed' });
  });
});
