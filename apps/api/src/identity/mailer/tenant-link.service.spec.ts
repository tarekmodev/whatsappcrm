import type { ConfigService } from '@nestjs/config';
import type { TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantLinkService } from './tenant-link.service';

function build(
  domain: { hostname: string } | null,
  scheme = 'https',
): { links: TenantLinkService; seenOrder: unknown } {
  let seenOrder: unknown;

  const prisma = {
    tenantDomain: {
      findFirst: (args: { orderBy: unknown }) => {
        seenOrder = args.orderBy;
        return Promise.resolve(domain);
      },
    },
  } as unknown as TenantPrisma;

  const config = { getOrThrow: () => scheme } as unknown as ConfigService;

  return {
    links: new TenantLinkService(prisma, config),
    get seenOrder() {
      return seenOrder;
    },
  };
}

describe('TenantLinkService', () => {
  it('puts the token in the fragment, where no server ever sees it', async () => {
    const { links } = build({ hostname: 'acme.app.example.com' });

    await expect(links.absoluteLink('/reset-password', 'tok3n')).resolves.toBe(
      'https://acme.app.example.com/reset-password#token=tok3n',
    );
  });

  it('escapes the token, so a base64url value cannot break the URL', async () => {
    const { links } = build({ hostname: 'acme.app.example.com' });

    await expect(links.absoluteLink('/reset-password', 'a+b/c=')).resolves.toBe(
      'https://acme.app.example.com/reset-password#token=a%2Bb%2Fc%3D',
    );
  });

  it('honours the configured scheme, so local development is not forced onto TLS', async () => {
    const { links } = build({ hostname: 'acme.app.localhost' }, 'http');

    await expect(links.absoluteLink('/reset-password', 'tok3n')).resolves.toBe(
      'http://acme.app.localhost/reset-password#token=tok3n',
    );
  });

  it('answers null when the tenant has no verified domain rather than inventing one', async () => {
    const { links } = build(null);

    await expect(links.absoluteLink('/reset-password', 'tok3n')).resolves.toBeNull();
  });

  it('prefers the primary domain, then the platform subdomain', async () => {
    const harness = build({ hostname: 'acme.app.example.com' });

    await harness.links.absoluteLink('/reset-password', 'tok3n');

    expect(harness.seenOrder).toEqual([
      { isPrimary: 'desc' },
      { kind: 'asc' },
      { createdAt: 'asc' },
    ]);
  });
});
