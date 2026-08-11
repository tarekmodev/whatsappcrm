import { describe, expect, it } from 'vitest';
import {
  SendMessageInputSchema,
  type MessageTemplateHeaderFormat,
  type MessageTemplateResponse,
} from '@whatsappcrm/contracts';
import { buildTemplateSend, emptyTemplateDraft, type TemplateDraft } from './template-draft';
import { EMPTY_ATTACHMENT, type ComposerAttachmentValue } from './media-draft';

const MEDIA_ID = '0192f00a-0000-7000-8000-000000000a01';

function uploaded(fileName = 'invoice.pdf'): ComposerAttachmentValue {
  return { status: 'ready', mediaId: MEDIA_ID, fileName, kind: 'document' };
}

function template(overrides: Partial<MessageTemplateResponse> = {}): MessageTemplateResponse {
  return {
    id: '0192f009-0000-7000-8000-000000000901',
    whatsappBusinessAccountId: '0192f005-0000-7000-8000-000000000502',
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved',
    components: null,
    bodyText: 'Hi {{1}}, order {{2}} is ready.',
    parameterCount: 2,
    headerFormat: null,
    headerParameterCount: 0,
    requiresButtonParameters: false,
    providerTemplateId: null,
    createdAt: '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-10T09:00:00.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    variables: [],
    headerVariables: [],
    headerMedia: EMPTY_ATTACHMENT,
    location: { latitude: '', longitude: '', name: '', address: '' },
    ...overrides,
  };
}

describe('emptyTemplateDraft', () => {
  it('sizes the draft to the placeholders the template publishes', () => {
    expect(emptyTemplateDraft(template({ headerFormat: 'text', headerParameterCount: 1 }))).toEqual(
      draft({ variables: ['', ''], headerVariables: [''] }),
    );
  });
});

describe('buildTemplateSend', () => {
  it('builds a send the contract accepts, naming the template by name and language', () => {
    const build = buildTemplateSend(template(), draft({ variables: ['Maria', 'A-1001'] }));

    expect(build).toEqual({
      outcome: 'ready',
      input: {
        type: 'template',
        templateName: 'order_update',
        languageCode: 'en_US',
        variables: ['Maria', 'A-1001'],
      },
    });
    // The composer's answer has to survive the schema the API validates with.
    expect(SendMessageInputSchema.safeParse(build).success).toBe(false);
    expect(
      SendMessageInputSchema.safeParse(build.outcome === 'ready' ? build.input : null).success,
    ).toBe(true);
  });

  it('trims what was typed', () => {
    const build = buildTemplateSend(template(), draft({ variables: ['  Maria  ', 'A-1001'] }));

    expect(build.outcome === 'ready' && build.input.variables).toEqual(['Maria', 'A-1001']);
  });

  it('refuses a blank value rather than sending a gap in the sentence', () => {
    expect(buildTemplateSend(template(), draft({ variables: ['Maria', '   '] }))).toEqual({
      outcome: 'incomplete',
      problem: 'body-variables',
    });
  });

  it('refuses the wrong number of values, as the send path would', () => {
    expect(buildTemplateSend(template(), draft({ variables: ['Maria'] }))).toEqual({
      outcome: 'incomplete',
      problem: 'body-variables',
    });
  });

  it('supplies no header for a template that publishes none', () => {
    const build = buildTemplateSend(template(), draft({ variables: ['Maria', 'A-1001'] }));

    // Not `header: undefined` — the send path refuses a header on a template
    // that has none, and an explicit key would be one.
    expect(build.outcome === 'ready' && 'header' in build.input).toBe(false);
  });

  describe('a text header', () => {
    const withTextHeader = template({ headerFormat: 'text', headerParameterCount: 1 });

    it('is supplied through its own slot, counted apart from the body', () => {
      expect(
        buildTemplateSend(
          withTextHeader,
          draft({ variables: ['Maria', 'A-1001'], headerVariables: ['Shipping'] }),
        ),
      ).toEqual({
        outcome: 'ready',
        input: {
          type: 'template',
          templateName: 'order_update',
          languageCode: 'en_US',
          variables: ['Maria', 'A-1001'],
          header: { format: 'text', variables: ['Shipping'] },
        },
      });
    });

    it('is refused while its own value is missing', () => {
      expect(
        buildTemplateSend(
          withTextHeader,
          draft({ variables: ['Maria', 'A-1001'], headerVariables: [''] }),
        ),
      ).toEqual({ outcome: 'incomplete', problem: 'header-variables' });
    });
  });

  describe('a media header', () => {
    it.each(['image', 'video'] as const satisfies readonly MessageTemplateHeaderFormat[])(
      'names the uploaded media for a %s header',
      (format) => {
        expect(
          buildTemplateSend(
            template({ headerFormat: format }),
            draft({
              variables: ['Maria', 'A-1001'],
              headerMedia: {
                status: 'ready',
                mediaId: MEDIA_ID,
                fileName: 'shot.jpg',
                kind: format,
              },
            }),
          ),
        ).toEqual({
          outcome: 'ready',
          input: expect.objectContaining({ header: { format, mediaId: MEDIA_ID } }) as unknown,
        });
      },
    );

    it('carries the file name for a document, so the recipient sees one', () => {
      const build = buildTemplateSend(
        template({ headerFormat: 'document' }),
        draft({ variables: ['Maria', 'A-1001'], headerMedia: uploaded() }),
      );

      expect(build.outcome === 'ready' && build.input.header).toEqual({
        format: 'document',
        mediaId: MEDIA_ID,
        fileName: 'invoice.pdf',
      });
    });

    it('trims a file name past the contract’s ceiling instead of refusing the send', () => {
      const build = buildTemplateSend(
        template({ headerFormat: 'document' }),
        draft({
          variables: ['Maria', 'A-1001'],
          headerMedia: uploaded(`${'a'.repeat(300)}.pdf`),
        }),
      );

      // The name came from the agent's operating system, not from them.
      expect(
        SendMessageInputSchema.safeParse(build.outcome === 'ready' && build.input).success,
      ).toBe(true);
    });

    it('is refused until something has been attached', () => {
      expect(
        buildTemplateSend(
          template({ headerFormat: 'image' }),
          draft({ variables: ['Maria', 'A-1001'] }),
        ),
      ).toEqual({ outcome: 'incomplete', problem: 'header-media' });
    });

    // The three not-ready states need three different things from the agent, and
    // collapsing them told somebody watching an upload to attach the file they
    // had just attached.
    it('says to wait while the header upload is still running', () => {
      expect(
        buildTemplateSend(
          template({ headerFormat: 'video' }),
          draft({
            variables: ['Maria', 'A-1001'],
            headerMedia: { status: 'uploading', fileName: 'clip.mp4' },
          }),
        ),
      ).toEqual({ outcome: 'incomplete', problem: 'header-media-uploading' });
    });

    it('says to pick another when the header upload failed', () => {
      expect(
        buildTemplateSend(
          template({ headerFormat: 'image' }),
          draft({
            variables: ['Maria', 'A-1001'],
            headerMedia: { status: 'failed', fileName: 'shot.jpg', message: 'too large' },
          }),
        ),
      ).toEqual({ outcome: 'incomplete', problem: 'header-media-failed' });
    });
  });

  describe('a location header', () => {
    const withLocation = template({ headerFormat: 'location' });

    it('takes coordinates, and the two labels only if they were given', () => {
      const build = buildTemplateSend(
        withLocation,
        draft({
          variables: ['Maria', 'A-1001'],
          location: { latitude: '24.7136', longitude: '46.6753', name: 'Depot', address: '  ' },
        }),
      );

      expect(build.outcome === 'ready' && build.input.header).toEqual({
        format: 'location',
        latitude: 24.7136,
        longitude: 46.6753,
        name: 'Depot',
      });
    });

    it('accepts a negative coordinate', () => {
      const build = buildTemplateSend(
        withLocation,
        draft({
          variables: ['Maria', 'A-1001'],
          location: { latitude: '-33.8688', longitude: '-70.6693', name: '', address: '' },
        }),
      );

      expect(build.outcome === 'ready' && build.input.header).toEqual({
        format: 'location',
        latitude: -33.8688,
        longitude: -70.6693,
      });
    });

    it.each([
      ['blank', '', '46.6753'],
      ['out of range', '91', '46.6753'],
      // `parseFloat('12abc')` is 12, which would drop a pin nobody meant to drop.
      ['part of a number', '12abc', '46.6753'],
      ['not a number at all', 'north', '46.6753'],
    ])('refuses a latitude that is %s', (_case, latitude, longitude) => {
      expect(
        buildTemplateSend(
          withLocation,
          draft({
            variables: ['Maria', 'A-1001'],
            location: { latitude, longitude, name: '', address: '' },
          }),
        ),
      ).toEqual({ outcome: 'incomplete', problem: 'header-coordinates' });
    });
  });
});
