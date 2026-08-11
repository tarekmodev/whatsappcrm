import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@whatsappcrm/contracts';
import { REQUIRED_PERMISSIONS } from '../../rbac/require-permission.decorator';
import { PLATFORM_ROUTE, PUBLIC_ROUTE } from './route-access';

/**
 * Every route in the application states its posture — once, and only once.
 *
 * This is the regression net behind TAR-58's "new endpoints are safe by
 * default". The global pipeline already refuses a route that declares nothing,
 * but it refuses it at runtime, on the first request somebody makes to it. This
 * fails in CI instead, the moment the controller is written, and it names the
 * handler.
 *
 * It walks the source tree rather than a hand-maintained list on purpose: a list
 * is exactly the thing a new controller gets left off, which is the failure mode
 * the whole story exists to remove.
 *
 * Adding a route means picking one of three:
 *
 *   * `@RequirePermission(...)` or `@AnyPrincipal()` — signed in, inside a
 *     tenant. The default, and the right answer for almost everything.
 *   * `@Public()` — no session, tenant still resolved from the host.
 *   * `@PlatformRoute()` — outside tenancy entirely, authenticated by something
 *     else or deliberately open.
 */

/**
 * Nest's own metadata key for a route path, on the controller and on each
 * handler. Written as a literal rather than imported from
 * `@nestjs/common/constants`, which is not part of the published surface — it
 * has been this string since v5, and a change would fail the first assertion
 * below loudly rather than quietly scanning nothing.
 */
const NEST_PATH_METADATA = 'path';

const SOURCE_ROOT = resolve(__dirname, '../..');

/** Generated Prisma output: thousands of files, no controllers. */
const SKIPPED_DIRECTORY = 'generated';

const reflector = new Reflector();

type RouteTarget = Type<unknown> | ((...args: never[]) => unknown);

interface Route {
  /** `UsersController.list (people/users.controller.ts)` — enough to go and fix it. */
  readonly name: string;
  /** Handler first, then controller: the order `getAllAndOverride` overrides in. */
  readonly targets: RouteTarget[];
}

function controllerFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === SKIPPED_DIRECTORY ? [] : controllerFilesUnder(path);
    }

    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

function routesIn(file: string): Route[] {
  // The path is discovered by the scan above, so a static import cannot express it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require(file) as Record<string, unknown>;
  const where = relative(SOURCE_ROOT, file).split(sep).join('/');

  return Object.values(module)
    .filter(
      (exported): exported is Type<unknown> =>
        typeof exported === 'function' && Reflect.hasMetadata(NEST_PATH_METADATA, exported),
    )
    .flatMap((controller) => {
      const { prototype } = controller as unknown as { prototype: object };

      return Object.getOwnPropertyNames(prototype)
        .filter((property) => property !== 'constructor')
        .map((property): unknown => Object.getOwnPropertyDescriptor(prototype, property)?.value)
        .filter(
          (handler): handler is (...args: never[]) => unknown =>
            typeof handler === 'function' && Reflect.hasMetadata(NEST_PATH_METADATA, handler),
        )
        .map((handler) => ({
          name: `${controller.name}.${handler.name} (${where})`,
          targets: [handler, controller],
        }));
    });
}

/** The postures a route declared. Anything other than exactly one is a defect. */
function posturesOf(route: Route): string[] {
  const declared: string[] = [];

  if (
    reflector.getAllAndOverride<readonly Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      route.targets,
    ) !== undefined
  ) {
    declared.push('@RequirePermission/@AnyPrincipal');
  }

  if (reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, route.targets) === true) {
    declared.push('@Public');
  }

  if (reflector.getAllAndOverride<boolean | undefined>(PLATFORM_ROUTE, route.targets) === true) {
    declared.push('@PlatformRoute');
  }

  return declared;
}

describe('every route declares its posture', () => {
  const routes = controllerFilesUnder(SOURCE_ROOT).flatMap(routesIn);

  // Guards the guard: a scan that silently matched nothing would pass every
  // assertion below and prove exactly nothing.
  it('finds the routes to check', () => {
    expect(routes.length).toBeGreaterThan(15);
  });

  it.each(routes.map((route) => [route.name, route] as const))(
    '%s declares exactly one',
    (_name, route) => {
      expect(posturesOf(route)).toHaveLength(1);
    },
  );
});
