import type { MessageTemplateComponentSummary } from './message-template-components';
import { messageTemplateSendBlockers } from './message-template-sendability';

/**
 * The exclusion predicate the composer's picker filters on and the
 * administration surface publishes.
 *
 * The assertion that carries the story is the last one: a template blocked twice
 * reports both reasons. An administrator told only "Meta has not approved this"
 * about a template that will *still* be missing after Meta approves it has been
 * given an answer that is true and useless.
 */

const NO_BUTTONS: MessageTemplateComponentSummary = {
  bodyText: 'Hello.',
  parameterCount: 0,
  headerFormat: null,
  headerParameterCount: 0,
  requiresButtonParameters: false,
};

const NEEDS_BUTTON_PARAMETERS: MessageTemplateComponentSummary = {
  ...NO_BUTTONS,
  requiresButtonParameters: true,
};

describe('messageTemplateSendBlockers', () => {
  it('reports nothing for the template the picker offers', () => {
    expect(messageTemplateSendBlockers('approved', NO_BUTTONS)).toEqual([]);
  });

  it.each(['pending', 'rejected', 'paused', 'disabled'] as const)(
    'reports a %s template as one Meta has not approved',
    (status) => {
      // Meta refuses a send on all four, so all four are the same answer to an
      // agent — and a different answer from "we cannot send this yet".
      expect(messageTemplateSendBlockers(status, NO_BUTTONS)).toEqual(['meta_not_approved']);
    },
  );

  it('reports an approved template the composer cannot fill as a product limit', () => {
    // The distinction the surface exists for: Meta said yes, we said not yet.
    expect(messageTemplateSendBlockers('approved', NEEDS_BUTTON_PARAMETERS)).toEqual([
      'button_parameters_required',
    ]);
  });

  it('reports both when both apply, rather than stopping at the first', () => {
    expect(messageTemplateSendBlockers('pending', NEEDS_BUTTON_PARAMETERS)).toEqual([
      'meta_not_approved',
      'button_parameters_required',
    ]);
  });
});
