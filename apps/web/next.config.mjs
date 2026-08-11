import { loadRepositoryEnvFile } from './repository-env-file.mjs';

/**
 * First, before anything below reads `process.env`: the repository-root `.env`
 * the README tells you to create is two directories above this app, and Next
 * only auto-loads the ones beside it (TAR-164).
 *
 * This runs while Next is loading its configuration, which is before it builds
 * the client define map — so `NEXT_PUBLIC_*` values from that file are still
 * inlined into the browser bundle, exactly as if they had come from
 * `apps/web/.env`.
 */
loadRepositoryEnvFile();

/**
 * The `/api/*` rewrite is load-bearing, not a convenience. A white-label tenant
 * (TAR-29) sits on its own domain; if the browser called the API host directly, the
 * session cookie would be third-party and modern browsers would drop it. Proxying
 * keeps every browser request first-party to whatever host the user is on.
 *
 * See docs/architecture/0002-architecture-and-api-contract.md, Decision 3.
 */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001/api';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript-built CommonJS; let Next compile them
  // with the app so source maps and tree shaking behave.
  transpilePackages: ['@whatsappcrm/contracts'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_BASE_URL}/:path*` }];
  },
};

export default nextConfig;
