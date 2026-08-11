import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPOSITORY_ENV_FILE, loadRepositoryEnvFile } from './repository-env-file.mjs';

/**
 * The failure this guards against is silent and expensive: `apps/web` reading no
 * `TRUSTED_PROXY_SECRET` does not crash, it answers `tenant_not_found` on every
 * API call and looks like a backend bug (TAR-164). Nothing here reads the
 * developer's own `.env` — the path is asserted structurally and the loading
 * behaviour against throwaway files.
 */

const scratchDirectories: string[] = [];

afterEach(() => {
  delete process.env.TAR_164_UNSET;
  delete process.env.TAR_164_ALREADY_SET;

  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('REPOSITORY_ENV_FILE', () => {
  /**
   * `.env` itself is not committed, so the sibling that documents it stands in:
   * `.env.example` only sits next to the repository root's `.env`, which makes
   * this fail if the `../../` ever stops landing there — the one way this module
   * breaks without anyone noticing.
   */
  it('resolves to the repository root, beside the .env.example it is copied from', () => {
    expect(path.basename(REPOSITORY_ENV_FILE)).toBe('.env');
    expect(existsSync(path.join(path.dirname(REPOSITORY_ENV_FILE), '.env.example'))).toBe(true);
  });
});

describe('loadRepositoryEnvFile', () => {
  it('publishes the file to process.env', () => {
    loadRepositoryEnvFile(envFileContaining('TAR_164_UNSET=from_the_file'));

    expect(process.env.TAR_164_UNSET).toBe('from_the_file');
  });

  /**
   * What makes the fix safe in production: Render sets each service's variables
   * directly, so the file must never be able to overwrite one.
   */
  it('leaves a variable the real environment already set alone', () => {
    process.env.TAR_164_ALREADY_SET = 'from_the_environment';

    loadRepositoryEnvFile(envFileContaining('TAR_164_ALREADY_SET=from_the_file'));

    expect(process.env.TAR_164_ALREADY_SET).toBe('from_the_environment');
  });

  /**
   * A deployed environment has no such file, and `next build` must not fail
   * because of it.
   */
  it('does nothing when there is no file to load', () => {
    expect(() => {
      loadRepositoryEnvFile(path.join(scratchDirectory(), 'absent.env'));
    }).not.toThrow();
  });
});

function envFileContaining(contents: string): string {
  const file = path.join(scratchDirectory(), '.env');

  writeFileSync(file, `${contents}\n`, 'utf8');

  return file;
}

function scratchDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'tar-164-'));

  scratchDirectories.push(directory);

  return directory;
}
