import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../../common/errors/api.exception';
import { PlatformAdminGuard } from './platform-admin.guard';

const TOKEN = 'a-platform-admin-token-of-at-least-32-chars';

describe('PlatformAdminGuard', () => {
  /** A context carrying just the one header the guard reads. */
  function contextWith(authorization?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          header: (name: string) =>
            name.toLowerCase() === 'authorization' ? authorization : undefined,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function guardWith(configured: string | undefined): PlatformAdminGuard {
    const config = { get: () => configured } as unknown as ConfigService;

    return new PlatformAdminGuard(config);
  }

  it('admits a request carrying the configured token', () => {
    expect(guardWith(TOKEN).canActivate(contextWith(`Bearer ${TOKEN}`))).toBe(true);
  });

  it('refuses everything when no token is configured, rather than admitting everything', () => {
    // The property that matters most here: an environment that was never given
    // a token cannot provision tenants for whoever asks first.
    expect(() => guardWith(undefined).canActivate(contextWith(`Bearer ${TOKEN}`))).toThrow(
      ApiException,
    );
    expect(() => guardWith('').canActivate(contextWith('Bearer '))).toThrow(ApiException);
  });

  it('refuses a wrong, absent, truncated or extended token', () => {
    const guard = guardWith(TOKEN);

    for (const header of [
      undefined,
      '',
      'Bearer ',
      'Bearer wrong',
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`,
    ]) {
      expect(() => guard.canActivate(contextWith(header))).toThrow(ApiException);
    }
  });

  it('refuses a token presented without the Bearer scheme', () => {
    const guard = guardWith(TOKEN);

    expect(() => guard.canActivate(contextWith(TOKEN))).toThrow(ApiException);
    expect(() => guard.canActivate(contextWith(`Basic ${TOKEN}`))).toThrow(ApiException);
    // Case-sensitive on purpose: RFC 6750 says `Bearer`, and accepting variants
    // widens the parser for no benefit.
    expect(() => guard.canActivate(contextWith(`bearer ${TOKEN}`))).toThrow(ApiException);
  });

  it('answers 401 with one indistinguishable message for every failure', () => {
    const messages = new Set<string>();

    for (const [configured, header] of [
      [TOKEN, undefined],
      [TOKEN, 'Bearer wrong'],
      [undefined, `Bearer ${TOKEN}`],
    ] as const) {
      try {
        guardWith(configured).canActivate(contextWith(header));
        throw new Error('expected the guard to refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiException);
        const failure = error as ApiException;

        expect(failure.getStatus()).toBe(401);
        expect(failure.code).toBe('unauthenticated');
        messages.add(failure.message);
      }
    }

    // One message across all three, so the response cannot be used to tell an
    // unconfigured environment from a wrong token.
    expect(messages.size).toBe(1);
  });
});
