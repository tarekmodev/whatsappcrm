import { fileURLToPath } from 'node:url';
import { loadRepositoryEnvFile } from '../web/repository-env-file.mjs';

/**
 * First, before anything below reads `process.env`: the repository-root `.env`
 * both apps share is two directories up, and Next only auto-loads the ones
 * beside it (TAR-164). Imported from `apps/web` rather than copied — one loader,
 * one set of rules about where the file is.
 */
loadRepositoryEnvFile();

/**
 * The platform-operator console: its own app, its own bundle, its own
 * deployment, and — the point of all three — **its own origin**.
 *
 * That separation is the security control TAR-804 asks for. `/admin` inside
 * `apps/web` would be same-origin with every tenant page on every white-label
 * host, so a stored XSS anywhere in the tenant console could drive an operator's
 * cross-tenant writes while they were signed in. `httpOnly`, `SameSite` and a
 * path-scoped cookie are all no help against that; a different origin is.
 *
 * ## No `/api` rewrite, deliberately
 *
 * `apps/web` proxies `/api/*` to the API so a tenant's session cookie stays
 * first-party. This app has the opposite requirement: the operator credential
 * must never be reachable from the browser at all, so **every** admin call is
 * made by this server against `API_BASE_URL`. Adding a rewrite here would create
 * the browser path that `lib/credential.ts` exists to deny.
 *
 * ## Why `@whatsappcrm/web` is transpiled
 *
 * This app consumes `apps/web`'s token layer and `components/ui` wholesale
 * rather than forking them (0002 spec §2.1). Turbopack resolves them through the
 * `@/*` path in `tsconfig.json`; `transpilePackages` is what compiles the
 * TypeScript and CSS Modules it finds there.
 *
 * When TAR-801's shared layer lands as a package, this becomes a dependency on
 * that package and the `@/*` path goes away — one edit, in this app only.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@whatsappcrm/contracts', '@whatsappcrm/web'],
  // The workspace root, so tracing follows the shared source out of this app.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default nextConfig;
