import { describe, expect, it } from 'vitest';
import {
  CANNED_RESPONSE_LIMITS,
  CANNED_RESPONSE_TRIGGER,
  CannedResponseCreateInputSchema,
  CannedResponseListResponseSchema,
  CannedResponseShortcutSchema,
  CannedResponseUpdateInputSchema,
} from './canned-responses';

/**
 * The rules from 0011 a reader cannot derive from the shape, and that the
 * console, the API and `canned_responses`' CHECK constraints would otherwise be
 * free to disagree about.
 */

describe('CannedResponseShortcutSchema', () => {
  it('accepts what an agent types, leading slash included', () => {
    for (const shortcut of ['/hours', '/refund-policy', '/vat_id', '/1', '/a1-b_c']) {
      expect(CannedResponseShortcutSchema.safeParse(shortcut).success).toBe(true);
    }
  });

  it('refuses a shortcut without the trigger, so the picker can always find it', () => {
    // The composer opens on `/` and matches the rest of the token: a stored
    // value without one is a row nobody can reach.
    expect(CannedResponseShortcutSchema.safeParse('hours').success).toBe(false);
  });

  it('refuses a second slash, so a shortcut can never contain the trigger', () => {
    // `https://acme.com/hours` must not be mistakable for one, which is also why
    // the console's trigger regex requires start-of-draft or whitespace.
    expect(CannedResponseShortcutSchema.safeParse('/support/hours').success).toBe(false);
  });

  it('refuses uppercase, whitespace and punctuation the picker cannot type', () => {
    for (const shortcut of ['/Hours', '/open hours', '/hours!', '/', '/-hours']) {
      expect(CannedResponseShortcutSchema.safeParse(shortcut).success).toBe(false);
    }
  });

  /**
   * `canned_responses_shortcut_format` spells the same bound as
   * `^/[a-z0-9][a-z0-9_-]{0,38}$` — 40 characters including the slash. If these
   * two ever disagree, the looser one turns a `validation_failed` into a 500 or
   * a rejected value the API said it would take.
   */
  it('caps the shortcut at exactly what the CHECK constraint allows', () => {
    const longest = `${CANNED_RESPONSE_TRIGGER}${'a'.repeat(CANNED_RESPONSE_LIMITS.shortcutLength - 1)}`;

    expect(longest).toHaveLength(CANNED_RESPONSE_LIMITS.shortcutLength);
    expect(CannedResponseShortcutSchema.safeParse(longest).success).toBe(true);
    expect(CannedResponseShortcutSchema.safeParse(`${longest}a`).success).toBe(false);
  });
});

describe('CannedResponseCreateInputSchema', () => {
  it('trims the title and the body before measuring them', () => {
    // The database bound accepts `'   '` — a CHECK on `trim()` would be stricter
    // than this schema, which is the one direction that produces a 500. So the
    // trim lives here, and a whitespace-only title is refused before it is
    // stored as an unpickable row.
    const parsed = CannedResponseCreateInputSchema.parse({
      shortcut: '/hours',
      title: '  Opening hours  ',
      body: '  We are open 9–5.  ',
    });

    expect(parsed).toEqual({
      shortcut: '/hours',
      title: 'Opening hours',
      body: 'We are open 9–5.',
    });
    expect(
      CannedResponseCreateInputSchema.safeParse({ shortcut: '/hours', title: '   ', body: 'x' })
        .success,
    ).toBe(false);
  });

  it('caps the body at the ceiling a WhatsApp text message can carry', () => {
    // 4096 is `SendTextInputSchema.body`'s limit. Equal by construction, so an
    // inserted response is always sendable as-is rather than sendable in
    // practice.
    const atLimit = 'x'.repeat(CANNED_RESPONSE_LIMITS.bodyLength);

    expect(
      CannedResponseCreateInputSchema.safeParse({
        shortcut: '/hours',
        title: 'Hours',
        body: atLimit,
      }).success,
    ).toBe(true);
    expect(
      CannedResponseCreateInputSchema.safeParse({
        shortcut: '/hours',
        title: 'Hours',
        body: `${atLimit}x`,
      }).success,
    ).toBe(false);
  });

  it('has no `isShared` field, because personal responses are out of scope at v1', () => {
    // Unknown keys are stripped rather than rejected (0002, conventions), so the
    // property worth asserting is that a client cannot set it — not that it 400s.
    const parsed = CannedResponseCreateInputSchema.parse({
      shortcut: '/hours',
      title: 'Hours',
      body: 'We are open 9–5.',
      isShared: false,
    });

    expect(parsed).not.toHaveProperty('isShared');
  });
});

describe('CannedResponseUpdateInputSchema', () => {
  it('accepts an empty patch, which the API answers as a no-op', () => {
    // A patch that moves no column writes nothing and announces nothing, so
    // there is nothing for the schema to refuse.
    expect(CannedResponseUpdateInputSchema.safeParse({}).success).toBe(true);
  });

  it('still holds a supplied field to the full grammar', () => {
    expect(CannedResponseUpdateInputSchema.safeParse({ shortcut: 'hours' }).success).toBe(false);
  });
});

describe('CannedResponseListResponseSchema', () => {
  it('keeps `CursorPage`s shape with a cursor that is always null', () => {
    // Unpaginated because the console resolves a typed shortcut against the
    // whole set locally (0011, decision 1). The shape stays so a generic list
    // client works unchanged and pagination is addable without a break.
    expect(
      CannedResponseListResponseSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(true);
    expect(CannedResponseListResponseSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      CannedResponseListResponseSchema.safeParse({ items: [], nextCursor: 'more' }).success,
    ).toBe(false);
  });
});
