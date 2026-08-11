import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from './tenant-context/tenant-context.service';

/**
 * The scheme and host a response may name back to itself — `https://acme.example`.
 *
 * Most of this API publishes paths, deliberately: `MediaObjectResponse.contentPath`
 * says so in its own comment, because the same row is served through a tenant's
 * platform subdomain and through its custom domain (TAR-29) and a stored
 * absolute URL would name whichever host was configured when it was written.
 *
 * `MessageAttachment.url` is the exception the contract makes — a `z.url()`,
 * absolute — so something has to join an origin on at the response boundary.
 * This is that something, and it exists as a service rather than a template
 * literal at the call site for two reasons:
 *
 *   * **The host is the one `HostTenantGuard` resolved**, from `Host` or from
 *     the forwarded-host header a trusted edge presented (TAR-148). Reading
 *     those headers again here would either duplicate the shared-secret check or
 *     trust the header ungated, which is the spoof that guard exists to prevent.
 *     It reads the value the guard recorded and nothing else.
 *   * **The scheme is configuration**, the same `APP_LINK_SCHEME` the invite and
 *     reset links use, so a local machine with no TLS is a variable rather than
 *     a branch on the environment name.
 */
@Injectable()
export class ResponseOriginService {
  private readonly scheme: string;

  constructor(
    config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {
    this.scheme = config.getOrThrow<string>('APP_LINK_SCHEME');
  }

  /**
   * The origin for the request in scope, without a trailing slash.
   *
   * Throws where there is none, which is a bug rather than a runtime state:
   * every route that reaches this has run behind `HostTenantGuard`, and a
   * caller outside a request scope — a queue worker, a socket relay before it
   * has a handshake — has no origin to publish and must not be handed a
   * plausible-looking wrong one.
   */
  require(): string {
    const hostname = this.tenantContext.hostname;

    if (hostname === null) {
      throw new Error(
        'No hostname in scope: ResponseOriginService.require() was called on a path that ' +
          'HostTenantGuard did not run on.',
      );
    }

    return `${this.scheme}://${hostname}`;
  }
}
