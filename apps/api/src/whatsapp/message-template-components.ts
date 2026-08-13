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
  headerParameterCount: number;
  requiresButtonParameters: boolean;
}

const EMPTY_SUMMARY: MessageTemplateComponentSummary = {
  bodyText: null,
  parameterCount: 0,
  headerFormat: null,
  headerParameterCount: 0,
  requiresButtonParameters: false,
};

/**
 * Button types whose behaviour is fixed at approval, so they need nothing in the
 * send call. A `url` button is the one that depends on its own content — Meta
 * allows a dynamic suffix — and is decided separately.
 *
 * An allowlist rather than a list of the types that do take a parameter, because
 * the derivation **fails closed** (0002, amendment 1): a button type this build
 * does not recognise counts as requiring one. The two errors are not symmetric.
 * Too narrow and an unsendable template reaches the picker and dies at Meta; too
 * broad and a sendable one goes missing, which is visible to the tenant,
 * explainable on the administration surface, and fixed by widening this list.
 *
 * `voice_call` is the **one deliberate exception** to that rule, and is listed
 * as an accepted risk rather than as a verified entry — see below. One exception
 * with a stated reason is not a broken invariant; an unlabelled one would be.
 *
 * ## Verification state — TAR-91, as of 2026-08-13
 *
 * Amendment 1 asks for both entries to be settled against Meta's current
 * documentation. What that has and has not produced, so the next build does not
 * repeat the reachable half:
 *
 *   * **Settled.** Meta's template-components page (both the
 *     `business-management-api` path and its migrated twin) describes a
 *     `quick_reply` button as "custom text-only buttons that immediately message
 *     you with the specified text string when tapped", with one documented
 *     property — the 25-character label. No creation-time variable and no
 *     `example`, unlike `url`, which is the one button type whose documentation
 *     mentions a variable. A `voice_call` button has no configurable field at
 *     all.
 *   * **Not settled, and not settleable from the documentation.** Whether Meta
 *     *rejects a send* that omits the `button` component. That is stated only on
 *     the send-side guide (`.../cloud-api/guides/send-message-templates/` and
 *     `.../whatsapp/messages/template-messages/`), which has answered HTTP 500
 *     on every attempt across four builds — most recently 2026-08-13.
 *
 * The question is narrower than "does a quick reply carry a payload", because
 * this product never consumes one: the send path emits header and body
 * components only (`meta-cloud-api.client.ts`), and an inbound button tap is
 * modelled as `{ text?: string }` and read as `button.text`
 * (`whatsapp-payload.schema.ts`, `whatsapp-message.mapper.ts`). Widening this
 * list means sending quick-reply templates with the button component omitted
 * entirely, so the only thing that matters is whether Meta accepts that.
 *
 *   * `quick_reply` stays **out**, fail-closed, until one live send says
 *     otherwise. The test that settles it: an approved template with a
 *     placeholder-free BODY and two QUICK_REPLY buttons, sent through
 *     `POST /{phone-number-id}/messages` with `template.components` omitted —
 *     exactly what `sendTemplate` produces today. 2xx with a message id that
 *     delivers and renders both buttons means add it here and replace this note
 *     with what was observed and when; any 4xx (expect the #132000 family) means
 *     it stays out, and the real fix is emitting button components from the send
 *     path — a composer and send-path change, not an allowlist edit.
 *   * `voice_call` stays **in**, as an accepted open risk rather than a to-do.
 *     Meta documents no configurable field for it, so there is nothing a send
 *     could supply; that is weaker evidence than a live send, for the same
 *     reason as above. The exposure is bounded — it needs a tenant with Calling
 *     enabled, an approved voice_call template, and an agent picking it — and
 *     the cost if wrong is one send that fails at Meta, not a wrong send.
 *
 * Neither can be closed without a WABA whose credentials the runtime holds, and
 * `voice_call` additionally needs one with Calling enabled.
 */
const PARAMETERLESS_BUTTON_TYPES: readonly string[] = ['phone_number', 'voice_call'];

/**
 * Positional placeholders only. Meta also allows named parameters
 * (`{{order_id}}`) on newer templates; they are ignored here because
 * `SendTemplateInput.variables` is positional, so a named placeholder has no
 * index for a caller to fill and counting it would produce an arity the send
 * path could never satisfy.
 */
const POSITIONAL_PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

/**
 * The same pattern without `g`. A global regex carries `lastIndex` between
 * calls, so reusing the one above for `test` would answer differently on
 * alternating calls with the same input.
 */
const HAS_POSITIONAL_PLACEHOLDER = /\{\{\s*\d+\s*\}\}/;

export function describeTemplateComponents(components: unknown): MessageTemplateComponentSummary {
  if (!Array.isArray(components)) {
    return EMPTY_SUMMARY;
  }

  const body = findComponent(components, 'body');
  const header = findComponent(components, 'header');
  const bodyText = readText(body);
  const headerFormat = header === undefined ? null : readHeaderFormat(header);
  const headerText = readText(header);

  const buttons = findComponent(components, 'buttons')?.buttons;

  return {
    bodyText,
    parameterCount: bodyText === null ? 0 : highestPlaceholder(bodyText),
    headerFormat,
    // Only a text header carries placeholders; media and location headers are
    // filled from the send input's own slot, so their count is zero rather than
    // whatever a stray `{{1}}` in a caption-like field might suggest.
    headerParameterCount:
      headerFormat === 'text' && headerText !== null ? highestPlaceholder(headerText) : 0,
    requiresButtonParameters: Array.isArray(buttons) && buttons.some(requiresParameter),
  };
}

/**
 * The v1 exclusion predicate, stated as the invariant the contract states:
 * a button requires a parameter in the send call, or it does not. Nothing else
 * about a `BUTTONS` component matters, and the list drops a template whose
 * answer is `true` for any of its buttons — the same rule as approved-only,
 * applied to the other way a listed template turns out to be unsendable.
 */
function requiresParameter(button: unknown): boolean {
  if (!isRecord(button) || typeof button.type !== 'string') {
    // A button this build cannot even read the type of is not one it can prove
    // is sendable.
    return true;
  }

  const type = button.type.toLowerCase();

  if (type === 'url') {
    // Meta permits a placeholder in the last path or query segment and attaches
    // an `example` to the button when it does; either signal marks a dynamic
    // suffix the send call has to supply. A url without one is a fixed link that
    // needs nothing, and excluding every url button would hide the common
    // "visit our site" template.
    //
    // A url this build cannot read is the unreadable-type case again, one field
    // down: the branch cannot prove the button is static, so it does not claim
    // it. Answering `false` here would leave one path through a fail-closed
    // predicate that fails open.
    if (typeof button.url !== 'string') {
      return true;
    }

    return HAS_POSITIONAL_PLACEHOLDER.test(button.url) || button.example !== undefined;
  }

  return !PARAMETERLESS_BUTTON_TYPES.includes(type);
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
