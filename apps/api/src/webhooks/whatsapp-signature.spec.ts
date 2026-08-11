import { createHmac } from 'node:crypto';
import { isValidWhatsAppSignature, matchesVerifyToken } from './whatsapp-signature';

const APP_SECRET = 'meta-app-secret';

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('isValidWhatsAppSignature', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}', 'utf8');

  it('accepts Meta’s signature over the raw body', () => {
    expect(isValidWhatsAppSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(isValidWhatsAppSignature(body, sign(body, 'someone-elses-app'), APP_SECRET)).toBe(false);
  });

  /**
   * The property the whole design rests on: the bytes are signed, not the
   * meaning. A body that was parsed and re-serialised is semantically identical
   * and cryptographically different, which is why the route reads `rawBody`.
   */
  it('rejects a body that was re-serialised rather than passed through verbatim', () => {
    // Meta pretty-prints nothing, but a proxy, a logging layer or an
    // `express.json()` round trip can all change the bytes without changing the
    // meaning. Whitespace is the cheapest way to demonstrate it.
    const asSent = Buffer.from('{ "object": "whatsapp_business_account", "entry": [] }', 'utf8');
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(asSent.toString('utf8'))), 'utf8');

    expect(reserialised.equals(asSent)).toBe(false);
    expect(isValidWhatsAppSignature(reserialised, sign(asSent), APP_SECRET)).toBe(false);
    expect(isValidWhatsAppSignature(asSent, sign(asSent), APP_SECRET)).toBe(true);
  });

  it('rejects a body that was tampered with after signing', () => {
    const signature = sign(body);
    const tampered = Buffer.from('{"object":"whatsapp_business_account","entry":[1]}', 'utf8');

    expect(isValidWhatsAppSignature(tampered, signature, APP_SECRET)).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['not a string', 42],
    ['missing the sha256= prefix', 'abcdef'],
    ['not hexadecimal', 'sha256=zzzz'],
    ['truncated', `${sign(Buffer.from('x')).slice(0, 20)}`],
  ])('rejects a header that is %s', (_case, header) => {
    expect(isValidWhatsAppSignature(body, header, APP_SECRET)).toBe(false);
  });

  /**
   * Nest only populates `rawBody` when the application is created with that
   * option. Returning `false` rather than throwing means the misconfiguration
   * shows up as a refused webhook and a log line, not as a 500 on a public route.
   */
  it('rejects an absent raw body instead of throwing', () => {
    expect(isValidWhatsAppSignature(undefined, sign(body), APP_SECRET)).toBe(false);
  });

  it('rejects an empty signature payload', () => {
    expect(isValidWhatsAppSignature(body, 'sha256=', APP_SECRET)).toBe(false);
  });
});

describe('matchesVerifyToken', () => {
  it('accepts the configured token', () => {
    expect(matchesVerifyToken('the-token', 'the-token')).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(matchesVerifyToken('the-tokeX', 'the-token')).toBe(false);
  });

  /** `timingSafeEqual` throws on unequal lengths; hashing first is what avoids it. */
  it('rejects a token of a different length without throwing', () => {
    expect(matchesVerifyToken('short', 'a-much-longer-configured-token')).toBe(false);
    expect(matchesVerifyToken('', 'a-much-longer-configured-token')).toBe(false);
  });
});
