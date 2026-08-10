import {
  MESSAGE_TEMPLATE_HEADER_FORMATS,
  type MessageTemplateHeaderFormat,
} from '@whatsappcrm/contracts';

/**
 * Reads the three fields the API derives from Meta's component tree (0002,
 * amendment 1): the body preview, the number of positional variables a send must
 * supply, and what the header expects.
 *
 * ## Why this is server-side
 *
 * `SendTemplateInputSchema.variables` is a positional array. With `components`
 * as the only published source, every consumer — the composer, the AI chatbot,
 * the workflow builder — would walk this tree itself to learn how many inputs to
 * render, each in its own unversioned parser, and the send path could not check
 * arity before calling Meta: a wrong `variables.length` would come back as an
 * opaque provider error instead of a `validation_failed`.
 *
 * ## Why it is derived rather than stored
 *
 * A page is capped at 100 rows, so this runs at most 100 times per request over
 * data already in memory. Columns would need a migration, a backfill, and a
 * guarantee that a template sync updates them — three ways for a copy to drift
 * from the tree it was copied from.
 *
 * ## Why every field is guarded
 *
 * `components` is stored exactly as Meta sent it and is deliberately not
 * validated (`MessageTemplateResponseSchema`), so this parser is the one place
 * that meets Meta's shape. It therefore assumes nothing: a tree that is null,
 * not an array, or full of unexpected types yields the empty summary rather than
 * a 500 on a list endpoint.
 */

/** What one template tells the composer, once the tree has been read. */
export interface MessageTemplateComponentSummary {
  bodyText: string | null;
  parameterCount: number;
  headerFormat: MessageTemplateHeaderFormat | null;
}

const EMPTY_SUMMARY: MessageTemplateComponentSummary = {
  bodyText: null,
  parameterCount: 0,
  headerFormat: null,
};

/**
 * Positional placeholders only. Meta also allows named parameters
 * (`{{order_id}}`) on newer templates; they are ignored here because
 * `SendTemplateInput.variables` is positional, so a named placeholder has no
 * index for a caller to fill and counting it would produce an arity the send
 * path could never satisfy.
 */
const POSITIONAL_PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

export function describeTemplateComponents(components: unknown): MessageTemplateComponentSummary {
  if (!Array.isArray(components)) {
    return EMPTY_SUMMARY;
  }

  const body = findComponent(components, 'body');
  const header = findComponent(components, 'header');
  const bodyText = readText(body);

  return {
    bodyText,
    parameterCount: bodyText === null ? 0 : highestPlaceholder(bodyText),
    headerFormat: header === undefined ? null : readHeaderFormat(header),
  };
}

/**
 * Meta sends `type` upper-case (`"BODY"`), but it is a string in a column we do
 * not validate, so the comparison is case-insensitive rather than trusting that.
 * The first match wins: a template has at most one BODY and one HEADER, and a
 * tree that somehow carries two is better read consistently than rejected.
 */
function findComponent(components: unknown[], type: string): Record<string, unknown> | undefined {
  return components
    .filter(isRecord)
    .find(
      (component) =>
        typeof component.type === 'string' && component.type.toLowerCase() === type.toLowerCase(),
    );
}

function readText(component: Record<string, unknown> | undefined): string | null {
  return component !== undefined && typeof component.text === 'string' ? component.text : null;
}

/**
 * The highest index, not the count of placeholders: Meta rejects a body that
 * skips one, but `{{2}}` alone still means a caller has to send two variables,
 * and a repeated `{{1}}` is one. This is exactly the length
 * `SendTemplateInput.variables` must have.
 */
function highestPlaceholder(text: string): number {
  let highest = 0;

  for (const [, index] of text.matchAll(POSITIONAL_PLACEHOLDER)) {
    highest = Math.max(highest, Number(index));
  }

  return highest;
}

/**
 * An unrecognised format reads as `null` rather than being passed through: the
 * contract publishes a closed enum, and a value Meta adds later must not fail
 * response validation for every template in the page.
 *
 * A header carrying `text` but no `format` is read as `text` — Meta's own
 * default for the field, and the alternative would report "no header" for a
 * template that visibly has one.
 */
function readHeaderFormat(header: Record<string, unknown>): MessageTemplateHeaderFormat | null {
  if (typeof header.format !== 'string') {
    return typeof header.text === 'string' ? 'text' : null;
  }

  const format = header.format.toLowerCase();

  return isHeaderFormat(format) ? format : null;
}

function isHeaderFormat(value: string): value is MessageTemplateHeaderFormat {
  return (MESSAGE_TEMPLATE_HEADER_FORMATS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
