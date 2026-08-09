import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from './error';
import { CursorPageQuerySchema } from './pagination';

describe('ApiErrorSchema', () => {
  it('accepts a minimal error envelope', () => {
    const parsed = ApiErrorSchema.parse({
      error: { code: 'not_found', message: 'Conversation not found', requestId: 'req_1' },
    });

    expect(parsed.error.code).toBe('not_found');
  });

  it('rejects an envelope without a requestId', () => {
    expect(() => ApiErrorSchema.parse({ error: { code: 'x', message: 'y' } })).toThrow();
  });
});

describe('CursorPageQuerySchema', () => {
  it('defaults the page size and coerces a string limit', () => {
    expect(CursorPageQuerySchema.parse({}).limit).toBe(25);
    expect(CursorPageQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects a limit above the cap', () => {
    expect(() => CursorPageQuerySchema.parse({ limit: 500 })).toThrow();
  });
});
