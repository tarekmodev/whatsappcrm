import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PlatformRoute,
  Public,
  PublicPlatformRoute,
  isPlatformRoute,
  isPublicRoute,
} from './route-access';

const reflector = new Reflector();

/**
 * A context built the way Nest builds one: metadata on the class, on the
 * handler, or on neither. `getAllAndOverride` reads the handler first, so a
 * route can restate what its controller said.
 */
function contextFor(options: {
  onClass?: readonly (() => ClassDecorator | MethodDecorator)[];
  onHandler?: readonly (() => ClassDecorator | MethodDecorator)[];
}): ExecutionContext {
  class RouteController {}
  const handler = (): void => undefined;

  for (const decorator of options.onClass ?? []) {
    (decorator() as (target: object) => void)(RouteController);
  }

  for (const decorator of options.onHandler ?? []) {
    (decorator() as (target: object) => void)(handler);
  }

  return {
    getClass: () => RouteController,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('route access', () => {
  it('reads nothing as closed, which is the whole point', () => {
    const context = contextFor({});

    expect(isPublicRoute(reflector, context)).toBe(false);
    expect(isPlatformRoute(reflector, context)).toBe(false);
  });

  it('reads @Public() from the controller and from a single route', () => {
    expect(isPublicRoute(reflector, contextFor({ onClass: [Public] }))).toBe(true);
    expect(isPublicRoute(reflector, contextFor({ onHandler: [Public] }))).toBe(true);
  });

  it('reads @PlatformRoute() from the controller and from a single route', () => {
    expect(isPlatformRoute(reflector, contextFor({ onClass: [PlatformRoute] }))).toBe(true);
    expect(isPlatformRoute(reflector, contextFor({ onHandler: [PlatformRoute] }))).toBe(true);
  });

  /**
   * The two are independent flags, not a scale. `@Public()` keeps
   * `HostTenantGuard`; only `@PlatformRoute()` removes it, and reading one as
   * implying the other would silently drop tenant resolution from every login
   * route.
   */
  it('does not let one exemption imply the other', () => {
    const publicRoute = contextFor({ onClass: [Public] });
    const platformRoute = contextFor({ onClass: [PlatformRoute] });

    expect(isPlatformRoute(reflector, publicRoute)).toBe(false);
    expect(isPublicRoute(reflector, platformRoute)).toBe(false);
  });

  /**
   * The third posture (TAR-405). It has to take a route out of tenant
   * resolution, because signup runs before the tenant exists — and
   * `PrincipalGuard` and `PermissionGuard` already stand down on a platform
   * route, so that one answer is what leaves the handler reachable by an
   * anonymous caller.
   */
  describe('@PublicPlatformRoute()', () => {
    it('takes the route out of tenant resolution, from the controller or one route', () => {
      expect(isPlatformRoute(reflector, contextFor({ onClass: [PublicPlatformRoute] }))).toBe(true);
      expect(isPlatformRoute(reflector, contextFor({ onHandler: [PublicPlatformRoute] }))).toBe(
        true,
      );
    });

    /**
     * Deliberately **not** `@Public()`. Nothing reads `isPublicRoute` for a route
     * that is already outside tenancy, and answering true here would make a
     * future reader believe the two flags are a hierarchy. `route-posture.spec.ts`
     * counts the posture through its own metadata key, so this route still
     * declares exactly one.
     */
    it('is its own posture rather than a public route', () => {
      const signupRoute = contextFor({ onClass: [PublicPlatformRoute] });

      expect(isPublicRoute(reflector, signupRoute)).toBe(false);
    });
  });
});
