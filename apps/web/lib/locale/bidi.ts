/**
 * Bidirectional isolation for the values that are not prose.
 *
 * A phone number or a hostname is read left to right whatever the surrounding
 * text does, and under `dir="rtl"` the browser does not work that out on its
 * own: the Unicode bidirectional algorithm resolves each *neutral* character —
 * a plus, a dot, a colon — from what sits either side of it, and where one side
 * is the Arabic paragraph the neutral goes with the paragraph.
 *
 * Two shapes in this codebase actually move, both measured in Chromium rather
 * than derived on paper:
 *
 *   - **Every E.164 phone number.** `+966501234567` renders `966501234567+`:
 *     the digits are one left-to-right run, but the leading `+` has no strong
 *     character before it, so it takes the paragraph's direction and comes out
 *     at the trailing end.
 *   - **A hostname whose first label is all digits.** `123.app.example.com`
 *     renders `app.example.com.123` — the numeric label is its own run and the
 *     dot after it is a neutral between a number and a letter. A tenant slug is
 *     typed by the person signing up and `123` passes `TenantSlugSchema`, so the
 *     signup preview reaches this on the first character.
 *
 * Shapes that are already correct without help, so not worth marking: a WABA id
 * or any other bare digit string, a hostname starting with a letter (`W7` makes
 * the trailing port take the letters' direction), a ticket reference, a
 * custom-field key, and an ordinary email address.
 *
 * ## Where there is an element, use `dir="ltr"` instead
 *
 * This module is for the places a value goes into a **string**, where there is
 * no element to reach: an `<option>` label, an `aria-label`, or a sentence built
 * by the content layer. Where there is markup, `dir="ltr"` on the *inline*
 * element is the established form — see `ContactsTable` or `CustomFieldsTable`.
 * Put it on a span rather than the surrounding block: `direction` also resolves
 * `text-align: start`, so a `dir` on a `<p>` re-aligns the whole line to the
 * left in an otherwise right-aligned card.
 *
 * ## Why the isolate characters and not `dir="ltr"` everywhere
 *
 * `<option>` cannot be wrapped — its label is text — and a `dir` on the option
 * element is not reflected in the closed select's own display on every browser.
 * The isolate characters travel with the string, so the same value is correct in
 * the listbox, in the closed control, and in the step summary that repeats it.
 *
 * ## Why this is unconditional
 *
 * `isolateLtr` is applied wherever the value is, not only under `dir="rtl"`. The
 * characters are invisible and a left-to-right run inside a left-to-right
 * paragraph is what it already was, so an English console is unchanged — and a
 * component that branched on the locale would be the thing the token layer's
 * whole shape exists to avoid. Nothing in this app asks what language it is in.
 */

/**
 * U+2066 LEFT-TO-RIGHT ISOLATE and U+2069 POP DIRECTIONAL ISOLATE.
 *
 * Isolate rather than the older embedding pair (U+202A/U+202C): an embedding
 * still lets the run influence how the neutral characters *around* it resolve,
 * so it would fix the value and disturb its neighbours. An isolate is opaque in
 * both directions, which is the property that makes this safe to apply without
 * reading the sentence it lands in.
 */
const LTR_ISOLATE = '⁦';
const POP_DIRECTIONAL_ISOLATE = '⁩';

/**
 * Mark `value` as a left-to-right run, isolated from the text around it.
 *
 * ```ts
 * label: isolateLtr(number.displayPhoneNumber)
 * ```
 *
 * Screen readers are unaffected: these are formatting characters with no spoken
 * form, and they do not change the characters between them. Do not put the
 * result somewhere it will be sent to the API or compared against a stored
 * value — this is for display only.
 */
export function isolateLtr(value: string): string {
  return `${LTR_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`;
}

/**
 * The inverse, for a test or an assertion that needs to compare against the raw
 * value. Not used by the app itself — a display string is never read back.
 */
export function stripBidiIsolates(value: string): string {
  return value.replaceAll(LTR_ISOLATE, '').replaceAll(POP_DIRECTIONAL_ISOLATE, '');
}
