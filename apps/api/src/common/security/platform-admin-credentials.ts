/**
 * `PLATFORM_ADMIN_TOKEN`, parsed (TAR-166).
 *
 * The variable used to hold one bare secret, which meant the audit trail could
 * say no more than "someone with the token". It now holds a set of named
 * credentials:
 *
 *     ops-alice:<secret>,ops-bob:<secret>,ci-provisioner:<secret>
 *
 * The label is not a secret and is written to `audit_logs.actor_label`; the
 * secret half never leaves this process. One entry per operator or automation,
 * so revoking one is deleting one entry rather than rotating everybody.
 *
 * ## The separators, and why these
 *
 * `,` between entries and `:` between label and secret. `openssl rand -base64`
 * emits `A-Za-z0-9+/=`, none of which is a comma, so the separator cannot appear
 * inside a generated secret. The label/secret split takes the **first** colon
 * only, so a hand-picked secret containing one still parses whole.
 *
 * ## Why this is shared rather than living in the guard
 *
 * `env.schema.ts` refuses to boot on a malformed value and `PlatformAdminGuard`
 * has to authenticate against the parsed result. Two parsers would eventually
 * disagree, and the failure that produces is an environment that boots and then
 * refuses every admin request — or worse, boots and accepts something the schema
 * meant to reject.
 */

/** One named platform-operator credential. */
export interface PlatformAdminCredential {
  /** Written to the audit trail. Not a secret. */
  label: string;
  /** Compared against the presented bearer token. Never logged, never returned. */
  secret: string;
}

/**
 * Lowercase so a label reads the same in the environment, the log line and the
 * audit row; no comma or colon so it cannot break the format it is written in.
 * Two to forty characters, which is room for `ops-alice` or `ci-provisioner` and
 * not for a sentence.
 */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/;

/**
 * The floor for a value an unauthenticated caller gets unlimited guesses at.
 * Unchanged from the single-token form — the labels are new, the strength
 * requirement is not.
 */
export const PLATFORM_ADMIN_SECRET_MIN_LENGTH = 32;

const ENTRY_SEPARATOR = ',';
const LABEL_SEPARATOR = ':';

/** Malformed configuration, reported with enough detail to fix it and none of the secret. */
export class InvalidPlatformAdminTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlatformAdminTokenError';
  }
}

/**
 * Parses the configured value into named credentials.
 *
 * An absent or blank value yields an empty list rather than an error: an
 * environment that was never given a token is a deliberate, supported state — it
 * disables the admin surface — while a *malformed* one is a mistake, and the two
 * deserve different answers. There is no transitional acceptance of the old
 * unlabelled form: a value without a label would write audit rows that cannot
 * name who acted, which is the gap this exists to close.
 *
 * No message here contains a secret, or any part of one. This runs at boot,
 * where the output goes to a deploy log that is not treated as a secret store.
 */
export function parsePlatformAdminCredentials(
  configured: string | undefined,
): PlatformAdminCredential[] {
  if (configured === undefined || configured.trim() === '') {
    return [];
  }

  const credentials = configured
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(parseEntry);

  if (credentials.length === 0) {
    throw new InvalidPlatformAdminTokenError('holds separators but no entry');
  }

  rejectDuplicates(credentials);

  return credentials;
}

function parseEntry(entry: string, index: number): PlatformAdminCredential {
  const at = entry.indexOf(LABEL_SEPARATOR);
  const position = `entry ${index + 1}`;

  if (at === -1) {
    throw new InvalidPlatformAdminTokenError(
      `${position} is not in \`label:secret\` form. Every credential is named, so the audit ` +
        'trail can say which operator acted; an unlabelled token is not accepted.',
    );
  }

  const label = entry.slice(0, at);
  const secret = entry.slice(at + LABEL_SEPARATOR.length);

  if (!LABEL_PATTERN.test(label)) {
    throw new InvalidPlatformAdminTokenError(
      `${position} has a label that is not 2-40 characters of \`a-z0-9._-\` starting with a ` +
        'letter or digit',
    );
  }

  if (secret.length < PLATFORM_ADMIN_SECRET_MIN_LENGTH) {
    throw new InvalidPlatformAdminTokenError(
      `${position} (\`${label}\`) has a secret shorter than ${PLATFORM_ADMIN_SECRET_MIN_LENGTH} ` +
        'characters. Generate one with `openssl rand -base64 48`.',
    );
  }

  return { label, secret };
}

/**
 * Two entries sharing a label make the audit trail ambiguous; two sharing a
 * secret make it wrong, because the guard would attribute a request to whichever
 * of them it happened to see last. Both are configuration mistakes worth
 * refusing to boot on rather than resolving silently.
 */
function rejectDuplicates(credentials: readonly PlatformAdminCredential[]): void {
  const labels = new Set<string>();
  const secrets = new Set<string>();

  for (const credential of credentials) {
    if (labels.has(credential.label)) {
      throw new InvalidPlatformAdminTokenError(`uses the label \`${credential.label}\` twice`);
    }

    if (secrets.has(credential.secret)) {
      throw new InvalidPlatformAdminTokenError(
        `gives the same secret to two labels, including \`${credential.label}\`, so an audit row ` +
          'could not say which of them acted',
      );
    }

    labels.add(credential.label);
    secrets.add(credential.secret);
  }
}
