import type { SendTemplateInput } from '@whatsappcrm/contracts';
import type { MessageTemplateComponentSummary } from '../whatsapp/message-template-components';
import { TemplateNotSendableError } from './conversations.errors';
import { assertTemplateSendable, renderTemplateBody } from './template-send.validator';

/**
 * Every refusal here is one Meta would otherwise answer with an opaque provider
 * error, after the message row exists — so the composer would show a reply that
 * quietly failed. These are the cases 0002 amendment 1 publishes
 * `parameterCount`, `headerFormat` and `headerParameterCount` for.
 */

const NO_HEADER: MessageTemplateComponentSummary = {
  bodyText: 'Hi {{1}}, your order {{2}} has shipped.',
  parameterCount: 2,
  headerFormat: null,
  headerParameterCount: 0,
  requiresButtonParameters: false,
};

function send(overrides: Partial<SendTemplateInput> = {}): SendTemplateInput {
  return {
    type: 'template',
    templateName: 'order_shipped',
    languageCode: 'en_US',
    variables: ['Maria', 'A-1001'],
    ...overrides,
  };
}

describe('assertTemplateSendable', () => {
  it('accepts a template whose variables match the approved body', () => {
    expect(() => assertTemplateSendable(send(), NO_HEADER, null)).not.toThrow();
  });

  it('refuses too few variables, naming both counts', () => {
    expect(() => assertTemplateSendable(send({ variables: ['Maria'] }), NO_HEADER, null)).toThrow(
      /takes 2 variable\(s\) and 1 were supplied/,
    );
  });

  it('refuses too many variables', () => {
    // Meta ignores the extra and renders a message the agent did not write, so
    // this is a refusal rather than a truncation.
    expect(() =>
      assertTemplateSendable(send({ variables: ['a', 'b', 'c'] }), NO_HEADER, null),
    ).toThrow(TemplateNotSendableError);
  });

  it('refuses a template whose buttons need send-time values, before anything else', () => {
    // Ordered first on purpose: a template that can never be sent should say so
    // rather than complain about the variables supplied for it.
    const unsendable = { ...NO_HEADER, requiresButtonParameters: true };

    expect(() => assertTemplateSendable(send({ variables: [] }), unsendable, null)).toThrow(
      /buttons that need values/,
    );
  });

  describe('the header', () => {
    const textHeader: MessageTemplateComponentSummary = {
      ...NO_HEADER,
      headerFormat: 'text',
      headerParameterCount: 1,
    };
    const imageHeader: MessageTemplateComponentSummary = {
      ...NO_HEADER,
      headerFormat: 'image',
      headerParameterCount: 0,
    };

    it('refuses a header for a template that has none', () => {
      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'text', variables: ['x'] } }),
          NO_HEADER,
          null,
        ),
      ).toThrow(/has no header/);
    });

    it('refuses a missing header for a template that declares one', () => {
      expect(() => assertTemplateSendable(send(), textHeader, null)).toThrow(
        /must be supplied with the send/,
      );
    });

    it('refuses a header whose format disagrees with the approved one', () => {
      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'text', variables: ['x'] } }),
          imageHeader,
          null,
        ),
      ).toThrow(/header is a image, and a text header was supplied/);
    });

    it('checks a text header arity separately from the body arity', () => {
      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'text', variables: ['one', 'two'] } }),
          textHeader,
          null,
        ),
      ).toThrow(/header takes 1 variable\(s\) and 2 were supplied/);
    });

    it('accepts a matching text header', () => {
      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'text', variables: ['x'] } }),
          textHeader,
          null,
        ),
      ).not.toThrow();
    });

    it('refuses media whose kind is not the header format Meta approved', () => {
      // Meta picks the renderer from the approved format, so a video offered as
      // an image header fails on its side with a media-type error that names
      // neither the template nor the upload.
      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'image', mediaId: MEDIA_ID } }),
          imageHeader,
          { kind: 'video' },
        ),
      ).toThrow(/header is a image, and the media supplied is a video/);
    });

    it('accepts media whose kind matches', () => {
      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'image', mediaId: MEDIA_ID } }),
          imageHeader,
          { kind: 'image' },
        ),
      ).not.toThrow();
    });

    it('accepts a location header, which carries no media and no variables', () => {
      const locationHeader: MessageTemplateComponentSummary = {
        ...NO_HEADER,
        headerFormat: 'location',
      };

      expect(() =>
        assertTemplateSendable(
          send({ header: { format: 'location', latitude: 24.7, longitude: 46.6 } }),
          locationHeader,
          null,
        ),
      ).not.toThrow();
    });
  });
});

describe('renderTemplateBody', () => {
  it('fills positional placeholders in order', () => {
    expect(renderTemplateBody('Hi {{1}}, order {{2}}.', ['Maria', 'A-1001'])).toBe(
      'Hi Maria, order A-1001.',
    );
  });

  it('fills a repeated placeholder with the same variable', () => {
    // `{{1}}` twice is one variable, which is what `parameterCount` counts.
    expect(renderTemplateBody('{{1}} and {{1}}', ['x'])).toBe('x and x');
  });

  it('tolerates whitespace inside the marker, as Meta writes it', () => {
    expect(renderTemplateBody('Hi {{ 1 }}', ['Maria'])).toBe('Hi Maria');
  });

  it('leaves a placeholder with no variable as it is', () => {
    // Unreachable past the arity check; left visible rather than blanked so a
    // regression in that check shows up instead of hiding.
    expect(renderTemplateBody('Hi {{1}} and {{2}}', ['Maria'])).toBe('Hi Maria and {{2}}');
  });

  it('is null for a template with no body text', () => {
    expect(renderTemplateBody(null, [])).toBeNull();
  });
});

const MEDIA_ID = '68444444-4444-7444-8444-4444444444f1';
