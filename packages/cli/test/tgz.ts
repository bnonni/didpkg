// A .tgz writer for tests: one ustar file entry, then gzip.
import { gzipSync } from 'node:zlib';

const enc = new TextEncoder();

/** A gzip tar with one file. The path must be at most 100 bytes. */
export function tgzOf(path: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(enc.encode(text), at);
  put(path, 0);
  put('0000644\0', 100);
  put(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  put('        ', 148);
  put('0', 156);
  put('ustar\x0000', 257);
  put(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  const tar = new Uint8Array(512 + Math.ceil(body.length / 512) * 512 + 1024);
  tar.set(header);
  tar.set(body, 512);
  return gzipSync(tar);
}

/** An `npm pack` style .tgz with one file, package/package.json. */
export const npmTgz = (pkg: Record<string, unknown>): Uint8Array => tgzOf('package/package.json', enc.encode(JSON.stringify(pkg)));
