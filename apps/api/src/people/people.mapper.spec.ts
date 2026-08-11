import { UserResponseSchema, type UserStatus } from '@whatsappcrm/contracts';
import { toUserResponse, type UserRow } from './people.mapper';

const ROW: UserRow = {
  id: '0192f0ff-0000-7000-8000-00000000a001',
  email: 'agent@example.invalid',
  name: 'Ada Agent',
  avatarUrl: null,
  role: 'agent',
  status: 'active',
  availability: 'available',
  lastSeenAt: new Date('2026-08-10T09:30:24.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  teamMemberships: [{ teamId: '0192f0ff-0000-7000-8000-00000000b001' }],
};

describe('user mapping', () => {
  it('produces exactly what the published contract accepts', () => {
    expect(() => UserResponseSchema.parse(toUserResponse(ROW))).not.toThrow();
  });

  // The mapping is the boundary that keeps `password_hash` out of the API. It
  // is written field by field so widening a `select` cannot widen a response —
  // this is the test that fails if somebody replaces it with a spread.
  it('publishes no field the contract does not name', () => {
    const response = toUserResponse({
      ...ROW,
      ...({ passwordHash: '$argon2id$v=19$leaked' } as Partial<UserRow>),
    });

    expect(Object.keys(response).sort()).toEqual(Object.keys(UserResponseSchema.shape).sort());
    expect(JSON.stringify(response)).not.toContain('argon2');
  });

  it.each<[UserStatus, boolean]>([
    ['invited', false],
    ['active', true],
    ['suspended', true],
    ['removed', false],
  ])('counts %s toward the seat limit: %s', (status, expected) => {
    expect(toUserResponse({ ...ROW, status }).occupiesSeat).toBe(expected);
  });

  it('reports timestamps as ISO strings with an offset, never as Dates', () => {
    const response = toUserResponse(ROW);

    expect(response.lastSeenAt).toBe('2026-08-10T09:30:24.000Z');
    expect(response.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('carries a never-seen user through as null rather than an epoch', () => {
    expect(toUserResponse({ ...ROW, lastSeenAt: null }).lastSeenAt).toBeNull();
  });
});
