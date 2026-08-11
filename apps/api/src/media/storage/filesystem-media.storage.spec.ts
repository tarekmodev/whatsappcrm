import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { MediaObjectMissingError, MediaTooLargeError } from '../media.errors';
import { FilesystemMediaStorage } from './filesystem-media.storage';

/**
 * The adapter against a real temporary directory rather than a mocked `fs`.
 *
 * Deliberately: the properties worth asserting here are filesystem properties —
 * that a rejected write leaves nothing behind, that a key cannot escape the
 * root, that a partial object is never readable — and a mock would assert the
 * calls this file makes rather than what they do.
 */

const KEY = 'tenants/70444444-4444-7444-8444-444444444401/image/aa11bb22-cc33';
const OTHER_KEY = 'tenants/70444444-4444-7444-8444-444444444402/image/aa11bb22-cc33';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

describe('FilesystemMediaStorage', () => {
  let root: string;
  let storage: FilesystemMediaStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tar70-media-'));
    storage = new FilesystemMediaStorage({
      getOrThrow: () => root,
    } as unknown as ConfigService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips the bytes it was given', async () => {
    const bytes = Buffer.from('an invoice, notionally');

    const written = await storage.putStream(KEY, Readable.from(bytes), 1_024);

    expect(written).toEqual({
      sizeBytes: bytes.length,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await expect(collect(await storage.getStream(KEY))).resolves.toEqual(bytes);
  });

  it('reports the size it measured, not the size it was promised', async () => {
    const { sizeBytes } = await storage.putStream(
      KEY,
      Readable.from([Buffer.alloc(10), Buffer.alloc(7)]),
      1_024,
    );

    expect(sizeBytes).toBe(17);
  });

  it('refuses a stream that passes the cap, and leaves nothing behind', async () => {
    await expect(storage.putStream(KEY, Readable.from(Buffer.alloc(2_048)), 1_024)).rejects.toThrow(
      MediaTooLargeError,
    );

    await expect(storage.getStream(KEY)).rejects.toThrow(MediaObjectMissingError);
    // Not even a staged file: a truncated object under any name is rubbish.
    await expect(readdir(join(root, '.staging'))).resolves.toEqual([]);
  });

  it('leaves no partial object when the source itself fails', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('the connection went away'));
      },
    });

    await expect(storage.putStream(KEY, failing, 1_024)).rejects.toThrow(/connection went away/);
    await expect(storage.getStream(KEY)).rejects.toThrow(MediaObjectMissingError);
  });

  it('replaces an object written under the same key', async () => {
    await storage.putStream(KEY, Readable.from(Buffer.from('first')), 1_024);
    await storage.putStream(KEY, Readable.from(Buffer.from('second')), 1_024);

    await expect(collect(await storage.getStream(KEY))).resolves.toEqual(Buffer.from('second'));
  });

  it('keeps two tenants apart under their own prefixes', async () => {
    await storage.putStream(KEY, Readable.from(Buffer.from('tenant a')), 1_024);
    await storage.putStream(OTHER_KEY, Readable.from(Buffer.from('tenant b')), 1_024);

    await expect(collect(await storage.getStream(KEY))).resolves.toEqual(Buffer.from('tenant a'));
    await expect(collect(await storage.getStream(OTHER_KEY))).resolves.toEqual(
      Buffer.from('tenant b'),
    );
  });

  it('reports a missing object as missing rather than as a stream error', async () => {
    await expect(storage.getStream(KEY)).rejects.toThrow(MediaObjectMissingError);
  });

  it('treats deleting nothing as a success', async () => {
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });

  it('forgets an object it deleted', async () => {
    await storage.putStream(KEY, Readable.from(Buffer.from('x')), 1_024);
    await storage.delete(KEY);

    await expect(storage.getStream(KEY)).rejects.toThrow(MediaObjectMissingError);
  });

  it.each([
    ['a traversal', 'tenants/../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows path', 'tenants\\other\\file'],
    ['an empty segment', 'tenants//image/aa11'],
    ['a single segment', 'passwd'],
    ['a dot segment', 'tenants/./image/aa11'],
  ])('refuses %s as a key', async (_name, key) => {
    // Not a typed media error: a key of the wrong shape is a programming fault
    // in this codebase, never something a request can cause.
    await expect(storage.putStream(key, Readable.from(Buffer.from('x')), 1_024)).rejects.toThrow(
      /Refusing a storage key/,
    );
    await expect(storage.getStream(key)).rejects.toThrow(/Refusing a storage key/);
    await expect(storage.delete(key)).rejects.toThrow(/Refusing a storage key/);
  });

  it('cannot be made to read a file outside the root', async () => {
    const outside = join(root, '..', `tar70-outside-${process.pid}`);

    await writeFile(outside, 'not yours');

    try {
      await expect(storage.getStream(`../tar70-outside-${process.pid}`)).rejects.toThrow(
        /Refusing a storage key/,
      );
      // And the file is untouched, which is the property that matters.
      await expect(readFile(outside, 'utf8')).resolves.toBe('not yours');
    } finally {
      await rm(outside, { force: true });
    }
  });
});
