import type { MediaKind, SendTemplateHeader, SendTemplateInput } from '@whatsappcrm/contracts';
import type { MessageTemplateComponentSummary } from '../whatsapp/message-template-components';
import { TemplateNotSendableError } from './conversations.errors';

/**
 * Everything about a template send that can be decided **before** the Cloud API
 * is called, in one place and with no I/O.
 *
 * 0002 amendment 1 states the rule this implements: the send handler "requires
 * `header` exactly when the named template publishes a non-null `headerFormat`,
 * refuses it otherwise, and requires the two formats to agree — all three before
 * the Cloud API call, which is the point of publishing the fields at all".
 *
 * Every one of these failures reaches Meta as an opaque provider error if it is
 * not caught here: a `parameterCount` complaint that names an index, or a
 * "template not found" that means "the header you sent is not the header we
 * approved". None of them is something an agent can act on, and all of them
 * arrive after the message row exists — so the composer would show a reply that
 * quietly failed.
 *
 * Pure, and separate from the service, because this is where the interesting
 * cases are: it is unit-tested against every arm of the header union without a
 * database, a queue, or Meta.
 */

/** What the media half of a header needs checked, once its object has been read. */
export interface HeaderMedia {
  readonly kind: MediaKind;
}

const MEDIA_HEADER_FORMATS = ['image', 'video', 'document'] as const;

type MediaHeaderFormat = (typeof MEDIA_HEADER_FORMATS)[number];

export function isMediaHeader(
  header: SendTemplateHeader,
): header is Extract<SendTemplateHeader, { format: MediaHeaderFormat }> {
  return (MEDIA_HEADER_FORMATS as readonly string[]).includes(header.format);
}

/**
 * Refuses a template send the approved template cannot satisfy.
 *
 * The order is deliberate: the button exclusion first, because a template that
 * can never be sent should say so rather than complaining about the variables
 * somebody supplied for it; then the body arity, then the header.
 *
 * @param headerMedia the stored object a media header names, already read and
 *   proved to belong to this tenant. `null` for a header that names none.
 */
export function assertTemplateSendable(
  input: SendTemplateInput,
  summary: MessageTemplateComponentSummary,
  headerMedia: HeaderMedia | null,
): void {
  if (summary.requiresButtonParameters) {
    throw TemplateNotSendableError.buttons();
  }

  if (input.variables.length !== summary.parameterCount) {
    throw TemplateNotSendableError.variables(summary.parameterCount, input.variables.length);
  }

  assertHeaderMatches(input.header, summary, headerMedia);
}

function assertHeaderMatches(
  header: SendTemplateHeader | undefined,
  summary: MessageTemplateComponentSummary,
  headerMedia: HeaderMedia | null,
): void {
  if (summary.headerFormat === null) {
    if (header !== undefined) {
      throw TemplateNotSendableError.header(
        'That template has no header, so no header may be supplied for it.',
      );
    }

    return;
  }

  if (header === undefined) {
    throw TemplateNotSendableError.header(
      `That template has a ${summary.headerFormat} header, which must be supplied with the send.`,
    );
  }

  if (header.format !== summary.headerFormat) {
    throw TemplateNotSendableError.header(
      `That template's header is a ${summary.headerFormat}, and a ${header.format} header was supplied.`,
    );
  }

  if (header.format === 'text' && header.variables.length !== summary.headerParameterCount) {
    throw TemplateNotSendableError.header(
      `That template's header takes ${summary.headerParameterCount} variable(s) and ` +
        `${header.variables.length} were supplied.`,
    );
  }

  if (isMediaHeader(header) && headerMedia !== null && headerMedia.kind !== header.format) {
    // Meta picks the renderer from the header format it approved, so an audio
    // file offered as an `image` header is refused on its side with a media-type
    // error that names neither the template nor the upload.
    throw TemplateNotSendableError.header(
      `That template's header is a ${header.format}, and the media supplied is a ${headerMedia.kind}.`,
    );
  }
}

/**
 * Re-exported, not implemented here: the composer (TAR-20g) previews the same
 * string before the send that this path stores on the row after it, so the
 * renderer moved to `packages/contracts` where both can read one copy. Kept on
 * this module's surface so the send path's existing call sites and tests still
 * name the file that owns template sending.
 */
export { renderTemplateBody } from '@whatsappcrm/contracts';
