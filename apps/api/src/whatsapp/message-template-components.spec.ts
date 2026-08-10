import { describeTemplateComponents } from './message-template-components';

/**
 * The three derived fields, read out of a tree this codebase does not validate.
 * Half of these cases are malformed input on purpose: `components` is stored
 * exactly as Meta sent it, so this parser is the only thing standing between a
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
    });
  });

  it('matches Meta component types case-insensitively, since the column is unvalidated', () => {
    const summary = describeTemplateComponents([
      { type: 'header', format: 'video' },
      { type: 'body', text: 'Hi {{1}}.' },
    ]);

    expect(summary).toEqual({ bodyText: 'Hi {{1}}.', parameterCount: 1, headerFormat: 'video' });
  });
});
