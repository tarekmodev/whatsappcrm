// Runs before the test framework is installed, so the environment is already in
// place by the time a module reads it at import time.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Both are optional outside production; setting them empty keeps a developer's
// local `.env` from pointing the suite at a real database.
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
