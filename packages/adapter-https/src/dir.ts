// @didpkg/adapter-https/dir: writes the static layout v1 to a local folder (ADR 0003 sections 3 and 7).
// The publisher deploys the folder (Pages, R2, rsync). This entry point uses node:fs, so not a browser.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { PublishInput, ReadOptions, StorageReader, StorageWriter, StoredFile } from '@didpkg/core/source';
import { layoutPath } from './layout.ts';

/** It also reads its folder, so `didpkg publish` can read the head index and a release back. */
export class DirWriter implements StorageWriter, StorageReader {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** The tarball, the release, then the index. The index write is the commit point (ADR 0003 section 3). */
  async publish({ name, version, release, tarball, index }: PublishInput): Promise<void> {
    await this.#put({ kind: 'tarball', name, version }, tarball, true);
    await this.#put({ kind: 'release', name, version }, release, true);
    await this.#put({ kind: 'index', name }, index, false);
  }

  async writeIndex({ name, index }: { name: string; index: Uint8Array }): Promise<void> {
    await this.#put({ kind: 'index', name }, index, false);
  }

  /** 0 or 1 copies. Only the size limit applies, because a local read does not stop. */
  async *read(file: StoredFile, { maxBytes }: ReadOptions): AsyncIterable<Uint8Array> {
    const bytes = await this.#get(join(this.#dir, ...layoutPath(file)));
    if (bytes && bytes.length > maxBytes) throw new Error(`${layoutPath(file).join('/')}: more than ${maxBytes} bytes`);
    if (bytes) yield new Uint8Array(bytes);
  }

  async #get(path: string): Promise<Buffer | undefined> {
    return readFile(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
  }

  // A published release and tarball do not change: a lockfile holds their integrity. The same bytes
  // again is a no-op, so a failed publish can run again. The rename makes each write atomic, so a
  // server on the folder never gives a part of a file.
  async #put(file: StoredFile, bytes: Uint8Array, immutable: boolean): Promise<void> {
    const path = join(this.#dir, ...layoutPath(file));
    if (immutable) {
      const old = await this.#get(path);
      if (old?.equals(bytes)) return;
      if (old) throw new Error(`${path}: a different file exists, and a published version does not change`);
    }
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
