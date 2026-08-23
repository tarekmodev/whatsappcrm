import type { PrismaClient } from '../generated/prisma/client';

export type { TenantPrisma } from './tenant-scope.extension';

/**
 * The un-scoped client, connected as `whatsappcrm_system`. It carries the
 * `system_unrestricted` policy on every protected table, so it reads and writes
 * across tenants — which makes it the widest hole in the isolation model and
 * the first place a review should look.
 *
 * TAR-39, decision 1, rule 1 confines it to five call sites: tenant
 * provisioning, login before a tenant is known, webhook ingest, the sweeper,
 * and platform reporting. Anything else belongs on `TenantPrisma`, and a sixth
 * call site needs a justification in review.
 *
 * **The sixth is `PlatformSettingsRepository`** (TAR-816), and its justification
 * is written where it can be checked against the code — at the top of that
 * class. In short: `platform_settings` and `platform_setting_changes` carry no
 * `tenant_id`, so `TenantPrisma` refuses them outright and the app role holds no
 * grant on either; the reads are a bounded set of platform-scoped rows keyed by
 * a code-owned allowlist; and the access is confined to that one class. A
 * seventh still needs a justification in review.
 *
 * A distinct client rather than a flag on `TenantPrisma` on purpose: a flag is
 * one typo away from being set, is invisible at the injection site, and cannot
 * be grepped for. This can — `SYSTEM_PRISMA` appears in the constructor of
 * every class allowed to use it, and nowhere else.
 */
export type SystemPrisma = PrismaClient;

/** Inject with `@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma`. */
export const TENANT_PRISMA = Symbol('TENANT_PRISMA');

/** Inject with `@Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma`. */
export const SYSTEM_PRISMA = Symbol('SYSTEM_PRISMA');
