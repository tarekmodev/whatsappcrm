// Runs before the test framework is installed, so the environment is already in
// place by the time a module reads it at import time.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` are mandatory (TAR-49), so the
// suite has to supply something for AppModule to boot. These point at a host that
// does not exist on purpose: the unit suite must never reach a real database, and
// the readiness specs assert exactly what an unreachable one looks like. Real
// database coverage is `pnpm --filter @whatsappcrm/api test:db`.
process.env.APP_DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.SYSTEM_DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';

// Optional outside production; cleared so a developer's local `.env` cannot point
// the suite at a real service.
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
