import { describeTemplateComponents } from './message-template-components';

/** The v1 exclusion predicate, read out of the same single pass as the rest. */
function requiresButtonParameters(components: unknown): boolean {
  return describeTemplateComponents(components).requiresButtonParameters;
}

/**
 * The derived fields, read out of a tree this codebase does not validate. Half
 * of these cases are malformed input on purpose: `components` is stored exactly
 * as Meta sent it, so this parser is the only thing standing between a
 * surprising tree and a 500 on the composer's picker.
 */

describe('describeTemplateComponents', () => {
  it('reads the body text with its placeholders intact, for the preview', () => {
    const summary = describeTemplateComponents([
      { type: 'BODY', text: 'Hi {{1}}, order {{2}} has shipped.' },
    ]);

    expect(summary.bodyText).toBe('Hi {{1}}, order {{2}} has shipped.');
  });

  it('counts the highest placeholder, which is the arity a send must supply', () => {
    expect(
      describeTemplateComponents([{ type: 'BODY', text: 'Hi {{1}}, order {{2}} — thanks {{1}}.' }])
        .parameterCount,
    ).toBe(2);
  });

  it('counts a template with no placeholders as needing no variables', () => {
    expect(
      describeTemplateComponents([{ type: 'BODY', text: 'Our office is closed today.' }])
        .parameterCount,
    ).toBe(0);
  });

  it('ignores named placeholders, which a positional variables array cannot fill', () => {
    expect(
      describeTemplateComponents([{ type: 'BODY', text: 'Hi {{name}}, order {{1}}.' }])
        .parameterCount,
    ).toBe(1);
  });

  it.each([
    ['IMAGE', 'image'],
    ['DOCUMENT', 'document'],
    ['LOCATION', 'location'],
  ])('reports a %s header as %s', (format, expected) => {
    expect(
      describeTemplateComponents([
        { type: 'HEADER', format },
        { type: 'BODY', text: 'Hello.' },
      ]).headerFormat,
    ).toBe(expected);
  });

  it('reads a header that carries text but no format as a text header', () => {
    expect(describeTemplateComponents([{ type: 'HEADER', text: 'Your order' }]).headerFormat).toBe(
      'text',
    );
  });

  it('reports a format this build does not publish as no header, not as itself', () => {
    // The contract publishes a closed enum. Passing an unknown value through
    // would fail response validation for the whole page the first time Meta
    // adds a format.
    expect(describeTemplateComponents([{ type: 'HEADER', format: 'CAROUSEL' }]).headerFormat).toBe(
      null,
    );
  });

  it('reports a template with no header as having none', () => {
    expect(describeTemplateComponents([{ type: 'BODY', text: 'Hello.' }]).headerFormat).toBe(null);
  });

  it('counts a text header placeholder separately from the body', () => {
    // The two are supplied through different slots of `SendTemplateInput`, so a
    // single total could not say which.
    const summary = describeTemplateComponents([
      { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
      { type: 'BODY', text: 'Hi {{1}}, it ships {{2}}.' },
    ]);

    expect(summary).toMatchObject({ parameterCount: 2, headerParameterCount: 1 });
  });

  it('counts no header parameters for a media header, which is filled from its own slot', () => {
    expect(
      describeTemplateComponents([
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'Hi {{1}}.' },
      ]).headerParameterCount,
    ).toBe(0);
  });

  it.each([
    ['null components', null],
    ['a tree that is not an array', { type: 'BODY', text: 'Hello.' }],
    ['an array of things that are not components', ['BODY', 42, null]],
    ['a body with no text', [{ type: 'BODY' }]],
    ['a component with no type', [{ text: 'Hello.' }]],
    ['an empty tree', []],
  ])('answers the empty summary for %s rather than throwing', (_case, components) => {
    expect(describeTemplateComponents(components)).toEqual({
      bodyText: null,
      parameterCount: 0,
      headerFormat: null,
      headerParameterCount: 0,
      requiresButtonParameters: false,
    });
  });

  it('matches Meta component types case-insensitively, since the column is unvalidated', () => {
    const summary = describeTemplateComponents([
      { type: 'header', format: 'video' },
      { type: 'body', text: 'Hi {{1}}.' },
    ]);

    expect(summary).toEqual({
      bodyText: 'Hi {{1}}.',
      parameterCount: 1,
      headerFormat: 'video',
      headerParameterCount: 0,
      requiresButtonParameters: false,
    });
  });
});

/**
 * Which templates the list has to hide. Buttons that take a parameter are out of
 * scope for v1 (0002, amendment 1), and offering one in the picker is the same
 * failure as offering an unapproved template: a send the agent cannot complete.
 */
describe('requiresButtonParameters', () => {
  function withButtons(buttons: unknown[]) {
    return [
      { type: 'BODY', text: 'Hello.' },
      { type: 'BUTTONS', buttons },
    ];
  }

  it.each([
    ['a template with no buttons at all', [{ type: 'BODY', text: 'Hello.' }]],
    [
      'a phone-number button',
      withButtons([{ type: 'PHONE_NUMBER', phone_number: '+15550001111' }]),
    ],
    [
      'a url button with a fixed link',
      withButtons([{ type: 'URL', text: 'Visit', url: 'https://example.test/orders' }]),
    ],
  ])('keeps %s in the picker', (_case, components) => {
    expect(requiresButtonParameters(components)).toBe(false);
  });

  it.each([
    [
      'a url button with a dynamic suffix',
      withButtons([{ type: 'URL', text: 'Track', url: 'https://example.test/orders/{{1}}' }]),
    ],
    [
      'a url button Meta attached an example to, which is how a dynamic one reads',
      withButtons([
        { type: 'URL', text: 'Track', url: 'https://example.test/orders', example: ['.../1001'] },
      ]),
    ],
    ['a quick-reply button, which takes a payload', withButtons([{ type: 'QUICK_REPLY' }])],
    ['a copy-code button, which takes a coupon', withButtons([{ type: 'COPY_CODE' }])],
    ['a button type this build has never seen', withButtons([{ type: 'FLOW' }])],
    ['a button whose type is unreadable', withButtons([{ label: 'mystery' }])],
  ])('hides %s, because nothing in the composer can fill it', (_case, components) => {
    expect(requiresButtonParameters(components)).toBe(true);
  });

  it('answers the same way on a repeated call, rather than alternating', () => {
    // A global regex carries `lastIndex` between calls; a stateful answer here
    // would drop a template from every other page.
    const components = withButtons([
      { type: 'URL', text: 'Track', url: 'https://example.test/orders/{{1}}' },
    ]);

    expect([requiresButtonParameters(components), requiresButtonParameters(components)]).toEqual([
      true,
      true,
    ]);
  });

  it('reads an unparseable tree as nothing to hide, leaving approved-only to decide', () => {
    expect(requiresButtonParameters(null)).toBe(false);
  });
});
