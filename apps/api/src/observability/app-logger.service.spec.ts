import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { DestinationStream } from 'pino';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { validateEnv } from '../config/env';
import { AppLoggerService, LOG_DESTINATION } from './app-logger.service';

interface CapturedLine {
  level: number;
  msg: string;
  service: string;
  env: string;
  requestId?: string;
  tenantId?: string | null;
  userId?: string | null;
  authorization?: string;
  password?: string;
  credentials?: { password: string };
}

/** Fails the test with a useful message instead of a null dereference. */
function onlyLine(lines: CapturedLine[]): CapturedLine {
  const [line] = lines;

  if (!line) {
    throw new Error('expected a log line to have been written, but none was');
  }

  return line;
}

/** Collects what pino actually serialises, rather than trusting the call site. */
function createCapture(): { lines: CapturedLine[]; stream: DestinationStream } {
  const lines: CapturedLine[] = [];

  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as CapturedLine);
      },
    },
  };
}

describe('AppLoggerService', () => {
  let logger: AppLoggerService;
  let tenantContext: TenantContextService;
  let lines: CapturedLine[];

  beforeEach(async () => {
    // The suite runs silent by default (jest.setup.js); this file is the one that
    // needs lines to actually be written.
    process.env.LOG_LEVEL = 'info';

    const capture = createCapture();
    lines = capture.lines;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
        TenantContextModule,
      ],
      providers: [AppLoggerService, { provide: LOG_DESTINATION, useValue: capture.stream }],
    }).compile();

    logger = moduleRef.get(AppLoggerService);
    tenantContext = moduleRef.get(TenantContextService);
  });

  afterEach(() => {
    process.env.LOG_LEVEL = 'silent';
  });

  it('stamps the service and environment on every line', () => {
    logger.log('booted');

    expect(lines).toHaveLength(1);
    expect(onlyLine(lines)).toMatchObject({ service: 'api', env: 'local', msg: 'booted' });
  });

  it('attaches the tenant identifier without the call site passing it', () => {
    tenantContext.run({ requestId: 'req-1', tenantId: null, userId: null }, () => {
      tenantContext.setTenant('tenant-a', 'user-7');
      logger.log('message stored');
    });

    expect(onlyLine(lines)).toMatchObject({
      requestId: 'req-1',
      tenantId: 'tenant-a',
      userId: 'user-7',
      msg: 'message stored',
    });
  });

  it('leaves tenant fields off work that runs outside a request scope', () => {
    logger.log('cron tick');

    expect(onlyLine(lines).requestId).toBeUndefined();
    expect(onlyLine(lines).tenantId).toBeUndefined();
  });

  it('does not carry one request scope into the next', () => {
    tenantContext.run({ requestId: 'req-1', tenantId: 'tenant-a', userId: null }, () => {
      logger.log('first');
    });
    tenantContext.run({ requestId: 'req-2', tenantId: 'tenant-b', userId: null }, () => {
      logger.log('second');
    });

    expect(lines.map((line) => line.tenantId)).toEqual(['tenant-a', 'tenant-b']);
  });

  it('redacts credentials before they reach the log destination', () => {
    logger
      .structured('Test')
      .info(
        { authorization: 'Bearer super-secret', credentials: { password: 'hunter2' } },
        'inbound call',
      );

    expect(onlyLine(lines).authorization).toBe('[redacted]');
    expect(onlyLine(lines).credentials?.password).toBe('[redacted]');
  });

  it('keeps an error stack on the line rather than in the message', () => {
    logger.error('boom', 'Error: boom\n    at somewhere');

    expect(onlyLine(lines)).toMatchObject({ msg: 'boom' });
    expect(onlyLine(lines)).toHaveProperty('stack', expect.stringContaining('at somewhere'));
  });
});
