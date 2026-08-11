import {
  InvalidPlatformAdminTokenError,
  parsePlatformAdminCredentials,
} from './platform-admin-credentials';

const ALICE = 'a-platform-admin-secret-of-at-least-32-chars';
const BOB = 'another-platform-admin-secret-32-chars-plus';

describe('parsePlatformAdminCredentials', () => {
  it('reads one entry', () => {
    expect(parsePlatformAdminCredentials(`ops-alice:${ALICE}`)).toEqual([
      { label: 'ops-alice', secret: ALICE },
    ]);
  });

  it('reads several, ignoring the whitespace a hand-edited value collects', () => {
    expect(parsePlatformAdminCredentials(` ops-alice:${ALICE} , ci-provisioner:${BOB} `)).toEqual([
      { label: 'ops-alice', secret: ALICE },
      { label: 'ci-provisioner', secret: BOB },
    ]);
  });

  it('splits on the first colon, so a secret may contain one', () => {
    const withColon = `${ALICE}:tail`;

    expect(parsePlatformAdminCredentials(`ops-alice:${withColon}`)).toEqual([
      { label: 'ops-alice', secret: withColon },
    ]);
  });

  it('treats absent and blank as "the admin surface is off"', () => {
    // A deliberate, supported state — distinct from a malformed value, which is
    // a mistake and fails the boot.
    expect(parsePlatformAdminCredentials(undefined)).toEqual([]);
    expect(parsePlatformAdminCredentials('   ')).toEqual([]);
  });

  it('refuses the old unlabelled form outright', () => {
    // No transitional dual-accept: a bare secret authenticates fine and writes
    // an audit row that cannot name who acted.
    expect(() => parsePlatformAdminCredentials(ALICE)).toThrow(InvalidPlatformAdminTokenError);
  });

  it('refuses a secret below the length floor', () => {
    expect(() => parsePlatformAdminCredentials('ops-alice:too-short')).toThrow(
      InvalidPlatformAdminTokenError,
    );
  });

  it.each([
    ['empty', `:${ALICE}`],
    ['one character', `a:${ALICE}`],
    ['uppercase', `Ops-Alice:${ALICE}`],
    ['spaced', `ops alice:${ALICE}`],
    ['over forty characters', `${'a'.repeat(41)}:${ALICE}`],
  ])('refuses a label that is %s', (_case, configured) => {
    expect(() => parsePlatformAdminCredentials(configured)).toThrow(InvalidPlatformAdminTokenError);
  });

  it('refuses a repeated label, which would make the trail ambiguous', () => {
    expect(() => parsePlatformAdminCredentials(`ops-alice:${ALICE},ops-alice:${BOB}`)).toThrow(
      InvalidPlatformAdminTokenError,
    );
  });

  it('refuses one secret under two labels, which would make the trail wrong', () => {
    expect(() => parsePlatformAdminCredentials(`ops-alice:${ALICE},ops-bob:${ALICE}`)).toThrow(
      InvalidPlatformAdminTokenError,
    );
  });

  it('never puts a secret in the message it reports', () => {
    // These messages reach a deploy log, which is not a secret store.
    for (const configured of [ALICE, 'ops-alice:short', `ops-alice:${ALICE},ops-alice:${BOB}`]) {
      const error = catchError(() => parsePlatformAdminCredentials(configured));

      expect(error).toBeInstanceOf(InvalidPlatformAdminTokenError);
      expect((error as Error).message).not.toContain(ALICE);
      expect((error as Error).message).not.toContain(BOB);
    }
  });
});

function catchError(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }

  throw new Error('expected the parser to refuse');
}
