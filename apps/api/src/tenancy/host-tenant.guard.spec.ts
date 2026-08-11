import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Env } from '../config/env.schema';
import type { SystemPrisma } from '../prisma/prisma.tokens';
import { HostTenantGuard } from './host-tenant.guard';

/**
 * The boot line, on its own.
 *
 * What the guard *does* with a forwarded host is asserted end to end over real
 * HTTP in `request-pipeline.http.spec.ts`; this covers the one thing a request
 * cannot show, which is what an operator reads in the log when the service comes
 * up. It matters because the two states that look alike from outside — a
 * finished rotation and one that stopped after step two — differ only here.
 */

const CURRENT = 'c'.repeat(64);
const PREVIOUS = 'p'.repeat(64);

function bootLineFor(secrets: Partial<Record<string, string>>): string {
  const config = {
    get: (key: string) => secrets[key],
  } as unknown as ConfigService<Env, true>;

  const guard = new HostTenantGuard(
    {} as Reflector,
    {} as SystemPrisma,
    {} as TenantContextService,
    config,
  );

  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  try {
    guard.onModuleInit();

    return String(log.mock.calls[0]?.[0]);
  } finally {
    log.mockRestore();
  }
}

describe('HostTenantGuard, at boot', () => {
  it('says forwarded-host trust is off when no secret is configured', () => {
    const line = bootLineFor({});

    expect(line).toContain('disabled');
    expect(line).toContain('Host header only');
  });

  it('says how many secrets it accepts, so a finished rotation is legible', () => {
    const line = bootLineFor({ TRUSTED_PROXY_SECRET: CURRENT });

    expect(line).toContain('enabled');
    expect(line).toContain('1 secret(s) accepted');
    expect(line).not.toContain('rotation is in progress');
  });

  it('flags a rotation that still has the previous secret active', () => {
    // Clearing PREVIOUS is the step with no consequence when skipped, so it is
    // the one that gets skipped — and a retired secret then stays valid forever.
    const line = bootLineFor({
      TRUSTED_PROXY_SECRET: CURRENT,
      TRUSTED_PROXY_SECRET_PREVIOUS: PREVIOUS,
    });

    expect(line).toContain('2 secret(s) accepted');
    expect(line).toContain('rotation is in progress');
  });

  it.each([
    ['none configured', {}],
    ['one configured', { TRUSTED_PROXY_SECRET: CURRENT }],
    [
      'a rotation in progress',
      { TRUSTED_PROXY_SECRET: CURRENT, TRUSTED_PROXY_SECRET_PREVIOUS: PREVIOUS },
    ],
  ])('never puts a secret value in the log with %s', (_label, secrets) => {
    const line = bootLineFor(secrets);

    expect(line).not.toContain(CURRENT);
    expect(line).not.toContain(PREVIOUS);
  });
});
