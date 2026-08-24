import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingChecklistResponse,
  type OnboardingStepId,
} from '@whatsappcrm/contracts';

/**
 * The console's half of the onboarding checklist, against a **real HTTP endpoint**
 * rather than a mocked `fetch` (TAR-835).
 *
 * The distinction is the whole point. `lib/api/onboarding.ts` was written against
 * the fixture transport, and the question this file answers is the one that
 * cannot be answered by reading it: with `NEXT_PUBLIC_USE_MOCK_API` off, does the
 * console put the right method, path and body on a socket, and does it accept
 * what TAR-832's contract says will come back? A `vi.fn()` standing in for
 * `fetch` would agree with whatever the module did, including the wrong path.
 *
 * The server below is a **contract stand-in, not a second mock transport**: it
 * implements TAR-832's two routes to the letter — derived completion, skips
 * persisted, `completed` beating `skipped`, 409 on skipping a completed step —
 * and nothing else. It exists so this file can assert the console's side of the
 * wire before TAR-834's endpoint is deployed, and it stays afterwards as the
 * regression guard for the wiring: a path typo or a contract drift fails here
 * rather than on the screen.
 *
 * Both base URLs are pointed at the stand-in, so the call goes over a socket
 * whichever branch of `resolveBaseUrl` the environment selects.
 *
 * The session is stubbed. Who the caller is belongs to `authenticated.test.ts`;
 * what this file owns is the request that goes out once they are known.
 */

vi.mock('server-only', () => ({}));

const { env } = vi.hoisted(() => ({
  env: {
    apiBaseUrl: '/api',
    serverApiBaseUrl: 'http://127.0.0.1:0/api',
    trustedProxySecret: undefined as string | undefined,
    useMockApi: false,
    enableRoleStub: false,
    isProduction: false,
  },
}));

vi.mock('@/lib/config/env', () => ({ webEnv: env }));
vi.mock('@/lib/session/session', () => ({ verifySession: () => Promise.resolve() }));
vi.mock('@/lib/session/session-cookie', () => ({
  sessionCookieHeaders: () => Promise.resolve({ cookie: SESSION_COOKIE }),
}));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: TENANT_HOST })),
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

const SESSION_COOKIE = '__Host-wac_session=opaque-session-id';
const TENANT_HOST = 'northwind.app.localhost:3000';
const TENANT_ID = '3f1b9a2c-6d0e-4f7a-9c11-8b2d5e4a7c30';
const CREATED_AT = '2026-01-05T09:00:00.000Z';
const RESOLVED_AT = '2026-02-11T14:30:00.000Z';

const { getOnboardingChecklist, updateOnboardingStep } = await import('./onboarding');
const { ApiRequestError } = await import('@/lib/api/http');

interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly cookie: string | undefined;
  readonly body: string;
}

/** What the stand-in persists, which per TAR-832 decision 1 is skips and nothing else. */
const skipped = new Set<OnboardingStepId>();
/** The facts the real API derives `completed` from, stood in for by a switch. */
const facts = new Set<OnboardingStepId>();
const received: ReceivedRequest[] = [];
/** Set by a case that needs the endpoint to answer something it should not. */
let malformedPayload: unknown;

let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;

  env.serverApiBaseUrl = `http://127.0.0.1:${port}/api`;
  env.apiBaseUrl = env.serverApiBaseUrl;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  skipped.clear();
  facts.clear();
  received.length = 0;
  malformedPayload = undefined;
});

describe('getOnboardingChecklist', () => {
  it('asks the real endpoint, at the path the contract publishes', async () => {
    await getOnboardingChecklist();

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.url).toBe('/api/v1/tenant/onboarding');
  });

  it('sends the caller’s session cookie, so the API has a tenant to scope by', async () => {
    await getOnboardingChecklist();

    expect(received[0]?.cookie).toBe(SESSION_COOKIE);
  });

  it('returns three pending steps for a workspace with nothing done yet', async () => {
    const checklist = await getOnboardingChecklist();

    expect(checklist.tenantId).toBe(TENANT_ID);
    expect(checklist.steps.map((step) => step.id)).toEqual([...ONBOARDING_STEP_IDS]);
    expect(checklist.steps.every((step) => step.status === 'pending')).toBe(true);
    expect(checklist.completedAt).toBeNull();
  });

  it('reports a step the tenant actually finished as completed', async () => {
    facts.add('connect_whatsapp');

    const checklist = await getOnboardingChecklist();
    const step = checklist.steps.find((candidate) => candidate.id === 'connect_whatsapp');

    expect(step?.status).toBe('completed');
    expect(step?.completedAt).toBe(RESOLVED_AT);
  });

  /**
   * The one place the payload is validated, and the reason no component needs to
   * defend itself against a bad one. A response that lost a step is rejected here
   * rather than rendering a two-item checklist and a meter that reads 2/2.
   */
  it('rejects a payload that does not satisfy the contract', async () => {
    malformedPayload = {
      tenantId: TENANT_ID,
      steps: [{ id: 'connect_whatsapp', status: 'pending', completedAt: null, skippedAt: null }],
      completedAt: null,
      updatedAt: CREATED_AT,
    };

    await expect(getOnboardingChecklist()).rejects.toThrow();
  });
});

describe('updateOnboardingStep', () => {
  it('PATCHes the step’s own path with the intent as the body', async () => {
    await updateOnboardingStep('set_branding', 'skip');

    expect(received[0]?.method).toBe('PATCH');
    expect(received[0]?.url).toBe('/api/v1/tenant/onboarding/steps/set_branding');
    expect(received[0]?.contentType).toBe('application/json');
    expect(JSON.parse(received[0]?.body ?? '')).toEqual({ intent: 'skip' });
  });

  it('answers with the whole checklist, not the one step that changed', async () => {
    const checklist = await updateOnboardingStep('set_branding', 'skip');

    expect(checklist.steps).toHaveLength(ONBOARDING_STEP_IDS.length);
    expect(checklist.steps.find((step) => step.id === 'set_branding')?.status).toBe('skipped');
  });

  /**
   * TAR-831's acceptance criterion, and the one thing the mock transport could
   * never prove: the skip is on the server, so the next load of the page shows
   * it. Two separate requests, with nothing carried between them but the API's
   * own state.
   */
  it('persists a skip across a reload of the page', async () => {
    await updateOnboardingStep('set_branding', 'skip');

    const reloaded = await getOnboardingChecklist();

    expect(reloaded.steps.find((step) => step.id === 'set_branding')?.status).toBe('skipped');
    expect(reloaded.steps.find((step) => step.id === 'set_branding')?.skippedAt).toBe(RESOLVED_AT);
  });

  it('puts a skipped step back, and that survives a reload too', async () => {
    await updateOnboardingStep('invite_agents', 'skip');
    await updateOnboardingStep('invite_agents', 'reopen');

    const reloaded = await getOnboardingChecklist();

    expect(reloaded.steps.find((step) => step.id === 'invite_agents')?.status).toBe('pending');
  });

  /** Decision 3: doing the thing supersedes having put it off. */
  it('shows a skipped step as completed once the tenant does the thing', async () => {
    await updateOnboardingStep('invite_agents', 'skip');
    facts.add('invite_agents');

    const step = (await getOnboardingChecklist()).steps.find(
      (candidate) => candidate.id === 'invite_agents',
    );

    expect(step?.status).toBe('completed');
    expect(step?.skippedAt).toBeNull();
  });

  /**
   * The console does not offer this — `onboardingStepIntent` gives a completed
   * step no control — but the refusal must still reach the caller as a refusal
   * rather than as a checklist, or a server action would report success.
   */
  it('surfaces the 409 for skipping a step that is already done', async () => {
    facts.add('connect_whatsapp');

    await expect(updateOnboardingStep('connect_whatsapp', 'skip')).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });
});

// --- The contract stand-in --------------------------------------------------

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const CHECKLIST_PATH = '/api/v1/tenant/onboarding';
const STEP_PATH = new RegExp(`^${CHECKLIST_PATH}/steps/([a-z_]+)$`);

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const url = request.url ?? '';

  received.push({
    method: request.method ?? '',
    url,
    contentType: request.headers['content-type'],
    cookie: request.headers.cookie,
    body,
  });

  if (request.method === 'GET' && url === CHECKLIST_PATH) {
    return send(response, HTTP_OK, malformedPayload ?? checklist());
  }

  const step = STEP_PATH.exec(url)?.[1];

  if (request.method === 'PATCH' && step !== undefined) {
    return patchStep(response, step, JSON.parse(body) as { intent: string });
  }

  return send(response, HTTP_NOT_FOUND, errorEnvelope('not_found', 'No such route.'));
}

function patchStep(response: ServerResponse, step: string, body: { intent: string }): void {
  if (!isStepId(step)) {
    // Divergence 2: a step id the contract does not name is a 404, not a 400.
    return send(response, HTTP_NOT_FOUND, errorEnvelope('not_found', 'No such step.'));
  }

  if (body.intent === 'skip') {
    if (facts.has(step)) {
      return send(
        response,
        HTTP_CONFLICT,
        errorEnvelope('conflict', 'That step is already done, so there is nothing to skip.'),
      );
    }

    skipped.add(step);
  } else {
    skipped.delete(step);
  }

  return send(response, HTTP_OK, checklist());
}

/** Completion derived, skips read from the store — TAR-832 decisions 1 and 3. */
function checklist(): OnboardingChecklistResponse {
  const steps = ONBOARDING_STEP_IDS.map((id) => ({
    id,
    status: facts.has(id)
      ? ('completed' as const)
      : skipped.has(id)
        ? ('skipped' as const)
        : ('pending' as const),
    completedAt: facts.has(id) ? RESOLVED_AT : null,
    skippedAt: !facts.has(id) && skipped.has(id) ? RESOLVED_AT : null,
  }));

  return {
    tenantId: TENANT_ID,
    steps,
    completedAt: steps.every((step) => step.status !== 'pending') ? RESOLVED_AT : null,
    updatedAt: steps.some((step) => step.status !== 'pending') ? RESOLVED_AT : CREATED_AT,
  };
}

function isStepId(value: string): value is OnboardingStepId {
  return (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

function errorEnvelope(code: string, message: string): unknown {
  return { error: { code, message, requestId: 'req_test' } };
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
