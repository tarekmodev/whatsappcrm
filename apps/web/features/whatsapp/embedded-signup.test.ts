import { describe, expect, it } from 'vitest';
import { parseEmbeddedSignupMessage } from './embedded-signup';

/**
 * The message channel Embedded Signup reports itself through, and the two things
 * about it worth pinning: which origins are trusted, and what a payload parses to.
 *
 * The origin check is the security one. This message decides which WABA the
 * console claims, and Meta's own published snippet tests
 * `origin.endsWith('facebook.com')` — which a look-alike domain satisfies.
 */

function message(origin: string, data: unknown): MessageEvent {
  return { origin, data } as MessageEvent;
}

const FINISH_PAYLOAD = {
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH',
  data: { waba_id: '102290129340398', phone_number_id: '106540352242922' },
};

describe('parseEmbeddedSignupMessage', () => {
  it('reads a finished run sent as JSON, which is how Meta sends it', () => {
    const parsed = parseEmbeddedSignupMessage(
      message('https://www.facebook.com', JSON.stringify(FINISH_PAYLOAD)),
    );

    expect(parsed).toEqual({
      event: 'FINISH',
      isCompletion: true,
      wabaId: '102290129340398',
      phoneNumberId: '106540352242922',
    });
  });

  it('reads the same payload sent as an object, so an SDK change is not a silent loss', () => {
    expect(parseEmbeddedSignupMessage(message('https://www.facebook.com', FINISH_PAYLOAD))).toEqual(
      expect.objectContaining({ isCompletion: true, wabaId: '102290129340398' }),
    );
  });

  it.each([
    ['a look-alike domain an endsWith check would let through', 'https://evilfacebook.com'],
    ['a look-alike with the name in a longer label', 'https://notfacebook.com'],
    ['the domain as a subdomain of somebody else', 'https://facebook.com.evil.example'],
    ['plain http', 'http://www.facebook.com'],
    ['an origin that is not a URL at all', 'null'],
  ])('refuses %s', (_label, origin) => {
    expect(parseEmbeddedSignupMessage(message(origin, JSON.stringify(FINISH_PAYLOAD)))).toBeNull();
  });

  /**
   * Meta posts from `www`, `web`, `business`, `m` and regional hosts, and adds
   * more without telling anyone. A fixed list would drop a run **silently** the
   * day it changed, so the test is "https, under facebook.com" — which the
   * look-alikes above still fail.
   */
  it.each([
    'https://www.facebook.com',
    'https://web.facebook.com',
    'https://business.facebook.com',
    'https://m.facebook.com',
    'https://en-gb.facebook.com',
    'https://facebook.com',
  ])('accepts %s', (origin) => {
    expect(
      parseEmbeddedSignupMessage(message(origin, JSON.stringify(FINISH_PAYLOAD)))?.isCompletion,
    ).toBe(true);
  });

  it.each([
    ['a message that is not JSON at all', 'hello'],
    ['a message with another type', JSON.stringify({ type: 'SOMETHING_ELSE', event: 'FINISH' })],
    ['a null payload', null],
  ])('ignores %s, because every page receives messages it did not ask for', (_label, data) => {
    expect(parseEmbeddedSignupMessage(message('https://www.facebook.com', data))).toBeNull();
  });

  /**
   * `FINISH_ONLY_WABA` is a run that produced a business account with no usable
   * number. It is accepted here and refused by the API, which answers with copy
   * naming the fix — a browser-side refusal would have to reach the same
   * conclusion from less information.
   */
  it.each(['FINISH', 'FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'])(
    'treats %s as a completed run',
    (event) => {
      const parsed = parseEmbeddedSignupMessage(
        message('https://www.facebook.com', JSON.stringify({ ...FINISH_PAYLOAD, event })),
      );

      expect(parsed?.isCompletion).toBe(true);
    },
  );

  it.each(['CANCEL', 'ERROR'])('reports %s without marking it a completion', (event) => {
    const parsed = parseEmbeddedSignupMessage(
      message('https://www.facebook.com', JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event })),
    );

    expect(parsed).toEqual({ event, isCompletion: false, wabaId: null, phoneNumberId: null });
  });

  /**
   * Dropped rather than passed on: the request would be rejected by the API's
   * schema after the authorisation code had already been spent, which costs the
   * tenant the whole run to learn nothing.
   */
  it('drops an id that is not a Meta id', () => {
    const parsed = parseEmbeddedSignupMessage(
      message(
        'https://www.facebook.com',
        JSON.stringify({ ...FINISH_PAYLOAD, data: { waba_id: 'not-an-id', phone_number_id: 42 } }),
      ),
    );

    expect(parsed).toEqual({
      event: 'FINISH',
      isCompletion: true,
      wabaId: null,
      phoneNumberId: null,
    });
  });
});
