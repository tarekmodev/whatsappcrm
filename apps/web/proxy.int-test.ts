import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGE_AUTH_HEADER, TENANT_HOST_HEADER } from '@whatsappcrm/contracts';

/**
 * Does the tenant header pair actually reach the API on the **browser** path?
 *
 * It cannot be answered by a unit test, and it must not be answered by reading
 * the documentation. The browser's route to the API is
 * `browser → this app → proxy.ts → next.config.mjs rewrite → API origin`, and
 * every hop of that belongs to Next: `NextResponse.next({ request: { headers } })`
 * only *asks* for a header by writing `x-middleware-override-headers` onto the
 * middleware response, and whether Next then applies it to a request it proxies to
 * an **external** origin is Next's business, undocumented, and has changed between
 * versions. `apps/web/AGENTS.md` says to verify rather than assume, and this branch
 * already found one belief about this pipeline (`Host` is preserved) to be false.
 *
 * So this builds the app the way a deploy does, starts it the way `render.yaml`
 * does, points the rewrite at a probe standing in for the API, and reads what the
 * probe was actually sent.
 *
 * It is also the only thing that would catch the two halves of the pair drifting
 * apart: the constants come from `@whatsappcrm/contracts`, the same module the
 * guard reads, so a rename that reached one side and not the other fails here
 * rather than in staging as a uniform `tenant_not_found` (TAR-148).
 *
 * ⚠️ Slow and stateful by nature: it runs a real `next build`, which overwrites
 * `.next`. That is why it is not part of `pnpm test` — it has its own config and
 * its own script (`pnpm --filter @whatsappcrm/web test:int`).
 *
 * If this ever fails because Next stopped propagating the headers, the fallback is
 * the one recorded on TAR-149: replace the `/api/*` rewrite with an explicit Route
 * Handler proxy at `app/api/[...path]/route.ts`, which owns streaming,
 * `set-cookie` pass-through and `HEAD` in exchange for being deterministic.
 */

const TENANT_HOST = 'northwind.app.localhost';
const TRUSTED_PROXY_SECRET = 'integration-test-edge-secret';
const PROBE_PATH = '/api/v1/probe';
const READY_TIMEOUT_MS = 120_000;

const require = createRequire(import.meta.url);
/** Next's real entrypoint, not `node_modules/.bin/next` — that is a shell wrapper. */
const NEXT_BIN = require.resolve('next/dist/bin/next');

interface ProbeRecord {
  readonly headers: IncomingHttpHeaders;
  readonly url: string;
}

let api: Server;
let web: ChildProcess;
let webPort: number;
const received: ProbeRecord[] = [];

beforeAll(async () => {
  api = createServer((incoming, response) => {
    received.push({ headers: incoming.headers, url: incoming.url ?? '' });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });

  api.listen(0, '127.0.0.1');
  await once(api, 'listening');

  const apiPort = portOf(api);

  // The rewrite destination is read at BUILD time and frozen into
  // `.next/routes-manifest.json`, so the probe has to be listening on a known
  // port before the build starts — the same build-time dependency `render.yaml`
  // documents for `API_BASE_URL`.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    API_BASE_URL: `http://127.0.0.1:${String(apiPort)}/api`,
    NEXT_PUBLIC_API_BASE_URL: '/api',
    NEXT_PUBLIC_USE_MOCK_API: 'false',
    NEXT_PUBLIC_ENABLE_ROLE_STUB: 'false',
    TRUSTED_PROXY_SECRET,
  };

  await run(NEXT_BIN, ['build'], env);

  webPort = await freePort();
  web = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(webPort)], {
    env,
    stdio: 'ignore',
  });

  await waitForListening(webPort);
}, READY_TIMEOUT_MS + 60_000);

afterAll(() => {
  web.kill();
  api.close();
});

describe('the browser path to the API', () => {
  it('delivers the tenant host and the credential that makes it believable', async () => {
    const headers = await callThroughProxy(PROBE_PATH, { host: TENANT_HOST });

    expect(headers[TENANT_HOST_HEADER]).toBe(TENANT_HOST);
    expect(headers[EDGE_AUTH_HEADER]).toBe(TRUSTED_PROXY_SECRET);
  });

  /**
   * The path is rewritten, not redirected, and the API sees it without the `/api`
   * prefix the browser used — so a change to either end of the rewrite that
   * silently reshaped the URL would show up here rather than as a 404 in staging.
   */
  it('reaches the API at the path the API publishes', async () => {
    await callThroughProxy('/api/v1/auth/session', { host: TENANT_HOST });

    expect(received.at(-1)?.url).toBe('/api/v1/auth/session');
  });

  /**
   * A browser can send any header it likes. If a forged `x-edge-auth` survived,
   * the pair would prove nothing and any visitor could name any tenant.
   */
  it('replaces a forged credential rather than forwarding it', async () => {
    const headers = await callThroughProxy(PROBE_PATH, {
      host: TENANT_HOST,
      [EDGE_AUTH_HEADER]: 'forged',
      [TENANT_HOST_HEADER]: 'victim.example.com',
    });

    expect(headers[EDGE_AUTH_HEADER]).toBe(TRUSTED_PROXY_SECRET);
    expect(headers[TENANT_HOST_HEADER]).toBe(TENANT_HOST);
  });

  /**
   * The reason `/api/*` was excluded from the proxy's matcher before this change:
   * answering an XHR with an HTML sign-in page turns the API's clean 401 into a
   * parse failure in the caller. Matching the path must not have brought that back.
   */
  it('does not send an unauthenticated API call to the sign-in screen', async () => {
    const before = received.length;
    const { status } = await raw(PROBE_PATH, { host: TENANT_HOST });

    expect(status).toBe(200);
    expect(received.length).toBe(before + 1);
  });
});

/**
 * `fetch` cannot set `Host` — it is a forbidden header name — and `Host` is the
 * whole input here, so the request is made at the `node:http` level instead.
 */
async function raw(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number | undefined }> {
  const outgoing = httpRequest({ host: '127.0.0.1', port: webPort, path, headers, method: 'GET' });

  // `events.once` would do, but it resolves to `any[]`; listening directly keeps
  // the response typed without a cast.
  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    outgoing.once('response', resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });

  // Drained rather than read: the probe's body is not what is under test, but an
  // unread response holds the socket open and the next request would queue.
  incoming.resume();
  await once(incoming, 'end');

  return { status: incoming.statusCode };
}

async function callThroughProxy(
  path: string,
  headers: Record<string, string>,
): Promise<IncomingHttpHeaders> {
  const before = received.length;

  await raw(path, headers);

  const record = received.at(-1);

  if (received.length !== before + 1 || record === undefined) {
    throw new Error(`The request to ${path} never reached the API probe.`);
  }

  return record.headers;
}

function portOf(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }

  return address.port;
}

/** Asks the OS for a port, then releases it — Next needs to bind it itself. */
async function freePort(): Promise<number> {
  const probe = createServer();

  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');

  const port = portOf(probe);

  probe.close();
  await once(probe, 'close');

  return port;
}

async function waitForListening(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await raw('/api/v1/ready-check', { host: TENANT_HOST });

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`next start did not accept a connection on port ${String(port)} in time.`);
}

async function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: 'inherit' });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });

  if (code !== 0) {
    throw new Error(`${script} ${args.join(' ')} exited with ${String(code)}.`);
  }
}
