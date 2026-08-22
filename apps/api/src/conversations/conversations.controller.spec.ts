import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  ConversationResponseSchema,
  MessageResponseSchema,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import {
  IdempotencyKeyReusedError,
  IdempotentRequestInFlightError,
} from '../common/idempotency/idempotency.errors';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { ConversationCommandService } from './conversation-command.service';
import { ConversationQueryService } from './conversation-query.service';
import { ConversationsController } from './conversations.controller';
import {
  ConversationAlreadyClaimedError,
  ConversationNotFoundError,
  ConversationUnclaimedError,
  ServiceWindowExpiredError,
  TemplateNotSendableError,
} from './conversations.errors';
import { InternalNotesService } from './internal-notes.service';
import { MessageQueryService } from './message-query.service';
import { MessageSendService } from './message-send.service';

/**
 * The HTTP contract of the ten inbox routes.
 *
 * The load-bearing assertions are the first two in each block: with no session
 * the route answers 401 and never reaches a service, and with the wrong
 * permission it answers 403. There is no path from an unauthenticated request
 * to a conversation, a message or a note.
 *
 * Proved with the **real** `PrincipalGuard` and `PermissionGuard`, registered as
 * `APP_GUARD` the way `RequestPipelineModule` registers them (TAR-58), and a
 * fake principal source in place of the session read. `HostTenantGuard` needs a
 * database, so the middleware below stands in for it — one `setTenant` call plus
 * the hostname it records, which is all this controller needs from it.
 *
 * The rest is the error mapping, which is where the codes a client branches on
 * are decided: `whatsapp_window_expired` switches the composer to the template
 * picker, and `idempotency_key_reused` is a bug in the client rather than a
 * conflict it can retry.
 */

const TENANT = '68444444-4444-7444-8444-444444444401';
const CONVERSATION = '68444444-4444-7444-8444-4444444444c1';
const KEY = '68444444-4444-7444-8444-4444444444e9';

const AGENT: SessionPrincipal = {
  userId: '68444444-4444-7444-8444-4444444444a1',
  tenantId: TENANT,
  email: 'agent@example.invalid',
  displayName: 'Ada Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '68444444-4444-7444-8444-4444444444e1',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

const CONVERSATION_RESPONSE = {
  id: CONVERSATION,
  contact: {
    id: '68444444-4444-7444-8444-4444444444d1',
    phone: '+966500000001',
    waProfileName: 'Maria',
    displayName: 'Maria',
    email: null,
    tags: [],
    customFields: {},
    lastContactedAt: null,
    optedOutAt: null,
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
  },
  whatsappAccountId: '68444444-4444-7444-8444-4444444444a0',
  status: 'open' as const,
  assignedUserId: null,
  assignedTeamId: null,
  ticketId: null,
  unreadCount: 0,
  serviceWindowExpiresAt: null,
  botState: 'off',
  botHandling: false,
  lastMessagePreview: 'Hello',
  lastMessageAt: '2026-08-11T09:00:00.000Z',
  createdAt: '2026-08-11T09:00:00.000Z',
  updatedAt: '2026-08-11T09:00:00.000Z',
};

const MESSAGE_RESPONSE = {
  id: '68444444-4444-7444-8444-4444444444e0',
  conversationId: CONVERSATION,
  direction: 'outbound' as const,
  type: 'text' as const,
  status: 'queued' as const,
  body: 'On its way.',
  attachments: [],
  sentByUserId: AGENT.userId,
  sentByAutomation: false,
  origin: 'contact',
  providerMessageId: null,
  failureReason: null,
  sentAt: '2026-08-11T09:00:00.000Z',
  createdAt: '2026-08-11T09:00:00.000Z',
};

describe('conversation routes', () => {
  let app: INestApplication;
  let server: Server;
  let signedIn: boolean;
  let principal: SessionPrincipal;

  let list: jest.Mock;
  let get: jest.Mock;
  let setStatus: jest.Mock;
  let assign: jest.Mock;
  let claim: jest.Mock;
  let markRead: jest.Mock;
  let listMessages: jest.Mock;
  let sendMessage: jest.Mock;
  let listNotes: jest.Mock;
  let createNote: jest.Mock;
  let execute: jest.Mock;

  beforeAll(async () => {
    list = jest.fn();
    get = jest.fn();
    setStatus = jest.fn();
    assign = jest.fn();
    claim = jest.fn();
    markRead = jest.fn();
    listMessages = jest.fn();
    sendMessage = jest.fn();
    listNotes = jest.fn();
    createNote = jest.fn();
    // The real replay semantics have their own spec against a fake table; here
    // the service is a pass-through so the routes can be exercised, plus the two
    // refusals whose HTTP codes are part of the contract.
    execute = jest.fn(async (_request: unknown, work: () => Promise<unknown>) => ({
      statusCode: 201,
      body: await work(),
      replayed: false,
    }));

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [ConversationsController],
      providers: [
        ApiExceptionFilter,
        { provide: ConversationQueryService, useValue: { list, get } },
        { provide: ConversationCommandService, useValue: { setStatus, assign, claim, markRead } },
        { provide: MessageQueryService, useValue: { list: listMessages } },
        { provide: MessageSendService, useValue: { send: sendMessage } },
        { provide: InternalNotesService, useValue: { list: listNotes, create: createNote } },
        { provide: IdempotencyService, useValue: { execute } },
        // Read by `configureApp` for the CORS allow-list; nothing here needs it.
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(signedIn ? resolved(principal) : ANONYMOUS) },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use((req: unknown, res: unknown, next: () => void) => {
      (middleware as { use: (a: unknown, b: unknown, c: () => void) => void }).use(req, res, () => {
        tenantContext.setTenant(TENANT);
        tenantContext.setHostname('acme.example');
        next();
      });
    });

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    signedIn = true;
    principal = AGENT;
  });

  describe('GET /api/v1/conversations', () => {
    it('refuses an unauthenticated caller before reaching the service', async () => {
      signedIn = false;

      const response = await request(server).get('/api/v1/conversations').expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(list).not.toHaveBeenCalled();
    });

    it('returns the page, and parses the published shape', async () => {
      list.mockResolvedValue({ items: [CONVERSATION_RESPONSE], nextCursor: null });

      const response = await request(server).get('/api/v1/conversations').expect(200);
      const page = response.body as { items: unknown[] };

      expect(ConversationResponseSchema.parse(page.items[0]).id).toBe(CONVERSATION);
    });

    it('applies the schema defaults rather than passing the raw query through', async () => {
      list.mockResolvedValue({ items: [], nextCursor: null });

      await request(server).get('/api/v1/conversations').expect(200);

      expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, scope: 'assigned' }));
    });

    it('rejects a limit above the documented maximum', async () => {
      const response = await request(server).get('/api/v1/conversations?limit=500').expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    });
  });

  describe('GET /api/v1/conversations/{id}', () => {
    it('answers 400 for an id that is not a UUID', async () => {
      const response = await request(server).get('/api/v1/conversations/not-a-uuid').expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(get).not.toHaveBeenCalled();
    });

    it('answers 404 — never 403 — for a conversation the caller may not see', async () => {
      // A 403 here would confirm the id names a real thread somebody else is
      // handling, which is the enumeration the taxonomy exists to prevent.
      get.mockRejectedValue(new ConversationNotFoundError(CONVERSATION));

      const response = await request(server)
        .get(`/api/v1/conversations/${CONVERSATION}`)
        .expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });
  });

  describe('POST /api/v1/conversations/{id}/claim', () => {
    function claimRequest() {
      return request(server).post(`/api/v1/conversations/${CONVERSATION}/claim`);
    }

    it('refuses an unauthenticated caller before reaching the service', async () => {
      signedIn = false;

      await claimRequest().expect(401);
      expect(claim).not.toHaveBeenCalled();
    });

    it('lets an agent take a thread nobody holds', async () => {
      // The point of the whole story: `conversation:assign` is a supervisor's,
      // and an inbox whose arriving work every agent can read and none can take
      // is not a shared inbox.
      claim.mockResolvedValue({ ...CONVERSATION_RESPONSE, assignedUserId: AGENT.userId });

      const response = await claimRequest().expect(200);

      expect(ConversationResponseSchema.parse(response.body).assignedUserId).toBe(AGENT.userId);
      expect(claim).toHaveBeenCalledWith(CONVERSATION);
    });

    it('names no assignee — the caller is the session, never a parameter', async () => {
      claim.mockResolvedValue({ ...CONVERSATION_RESPONSE, assignedUserId: AGENT.userId });

      // A body naming somebody else changes nothing: the route takes none, so a
      // claim can never be a re-assignment wearing `conversation:claim`.
      await claimRequest().send({ userId: '68444444-4444-7444-8444-4444444444d9' }).expect(200);

      expect(claim).toHaveBeenCalledWith(CONVERSATION);
    });

    it('answers 409 conflict when somebody else claimed it first', async () => {
      claim.mockRejectedValue(new ConversationAlreadyClaimedError(CONVERSATION));

      const response = await claimRequest().expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('answers 400 for an id that is not a UUID', async () => {
      await request(server).post('/api/v1/conversations/not-a-uuid/claim').expect(400);
      expect(claim).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/conversations/{id}/assign', () => {
    it('refuses an agent, who does not hold conversation:assign', async () => {
      const response = await request(server)
        .post(`/api/v1/conversations/${CONVERSATION}/assign`)
        .send({ userId: AGENT.userId })
        .expect(403);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
      expect(assign).not.toHaveBeenCalled();
    });

    it('lets a supervisor claim a conversation', async () => {
      principal = {
        ...AGENT,
        role: 'supervisor',
        permissions: [...permissionsForRole('supervisor')],
      };
      assign.mockResolvedValue({ ...CONVERSATION_RESPONSE, assignedUserId: AGENT.userId });

      const response = await request(server)
        .post(`/api/v1/conversations/${CONVERSATION}/assign`)
        .send({ userId: AGENT.userId })
        .expect(200);

      expect(ConversationResponseSchema.parse(response.body).assignedUserId).toBe(AGENT.userId);
    });

    it('rejects a body naming neither a user nor a team', async () => {
      principal = {
        ...AGENT,
        role: 'supervisor',
        permissions: [...permissionsForRole('supervisor')],
      };

      await request(server)
        .post(`/api/v1/conversations/${CONVERSATION}/assign`)
        .send({})
        .expect(400);
    });
  });

  describe('POST /api/v1/conversations/{id}/read', () => {
    it('answers 204 and nothing else', async () => {
      markRead.mockResolvedValue(undefined);

      const response = await request(server)
        .post(`/api/v1/conversations/${CONVERSATION}/read`)
        .expect(204);

      expect(response.body).toEqual({});
    });
  });

  describe('POST /api/v1/conversations/{id}/messages', () => {
    const body = { type: 'text', body: 'On its way.' };

    function send() {
      return request(server).post(`/api/v1/conversations/${CONVERSATION}/messages`);
    }

    it('refuses an unauthenticated caller', async () => {
      signedIn = false;

      await send().set('Idempotency-Key', KEY).send(body).expect(401);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('requires an Idempotency-Key, and says so before anything is looked up', async () => {
      const response = await send().send(body).expect(400);

      expect(ApiErrorSchema.parse(response.body).error.details?.[0]?.path).toBe('Idempotency-Key');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('requires that key to be a UUID', async () => {
      await send().set('Idempotency-Key', 'not-a-uuid').send(body).expect(400);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('answers 201 with the queued message', async () => {
      sendMessage.mockResolvedValue(MESSAGE_RESPONSE);

      const response = await send().set('Idempotency-Key', KEY).send(body).expect(201);

      expect(MessageResponseSchema.parse(response.body).status).toBe('queued');
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ key: KEY, operation: 'conversation.send', target: CONVERSATION }),
        expect.any(Function),
      );
    });

    it('answers the stored response on a replay, without re-executing', async () => {
      execute.mockResolvedValueOnce({ statusCode: 201, body: MESSAGE_RESPONSE, replayed: true });

      const response = await send().set('Idempotency-Key', KEY).send(body).expect(201);

      expect(MessageResponseSchema.parse(response.body).id).toBe(MESSAGE_RESPONSE.id);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('answers 409 idempotency_key_reused for the same key with a different body', async () => {
      execute.mockRejectedValueOnce(new IdempotencyKeyReusedError(KEY));

      const response = await send().set('Idempotency-Key', KEY).send(body).expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('idempotency_key_reused');
    });

    it('answers 409 conflict while a first attempt is still running', async () => {
      // A different fact from the one above: this one is retryable with the
      // same key, and that one never is.
      execute.mockRejectedValueOnce(new IdempotentRequestInFlightError(KEY));

      const response = await send().set('Idempotency-Key', KEY).send(body).expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('answers 409 conflict for a thread nobody has claimed', async () => {
      // TAR-186: the shared pool is readable by every agent, so without this the
      // two of them looking at the same arriving thread both reply and the
      // customer gets two answers. An idempotency key cannot catch it — each
      // agent sends a distinct request, with a distinct key.
      sendMessage.mockRejectedValue(new ConversationUnclaimedError(CONVERSATION));

      const response = await send().set('Idempotency-Key', KEY).send(body).expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('answers whatsapp_window_expired outside the service window', async () => {
      sendMessage.mockRejectedValue(new ServiceWindowExpiredError());

      const response = await send().set('Idempotency-Key', KEY).send(body).expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('whatsapp_window_expired');
    });

    it('answers whatsapp_template_invalid for a template that is not approved', async () => {
      sendMessage.mockRejectedValue(TemplateNotSendableError.notApproved('order_shipped'));

      const response = await send()
        .set('Idempotency-Key', KEY)
        .send({ type: 'template', templateName: 'order_shipped', languageCode: 'en_US' })
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('whatsapp_template_invalid');
    });

    it('rejects a body that is not one of the three send shapes', async () => {
      await send().set('Idempotency-Key', KEY).send({ type: 'carrier-pigeon' }).expect(400);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/conversations/{id}/notes', () => {
    it('does not require an Idempotency-Key — a note has no external side effect', async () => {
      createNote.mockResolvedValue({
        id: '68444444-4444-7444-8444-4444444444cc',
        conversationId: CONVERSATION,
        authorUserId: AGENT.userId,
        body: 'Chased the courier.',
        mentionedUserIds: [],
        createdAt: '2026-08-11T09:00:00.000Z',
      });

      await request(server)
        .post(`/api/v1/conversations/${CONVERSATION}/notes`)
        .send({ body: 'Chased the courier.' })
        .expect(201);
    });

    it('refuses an empty note', async () => {
      await request(server)
        .post(`/api/v1/conversations/${CONVERSATION}/notes`)
        .send({ body: '' })
        .expect(400);
    });
  });
});
