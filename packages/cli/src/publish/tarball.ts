// The package.json of an `npm pack` tarball, and the signed `npm` fields of the release (PLAN.md signed objects).
// npm removes the first path part (`package/`), so this reader uses the files of the top folder.
import { gunzipSync } from 'node:zlib';

export interface PackedPackage {
  name: string;
  version: string;
  /** The packument fields of the release: dependencies, bin, engines, hasInstallScript. */
  npm: Record<string, unknown>;
}

const td = new TextDecoder();
const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** The files of the top folder (path, body). Only regular files. POSIX ustar, pax `path` and GNU long names. */
function topFiles(tgz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Uint8Array>();
  let longPath: string | undefined;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const text = (from: number, length: number) => td.decode(header.subarray(from, from + length)).replace(/\0[^]*$/, '');
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size)) throw new Error('the tarball has a bad tar header');
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    const type = text(156, 1);
    if (type === 'x') {
      longPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(td.decode(body))?.[1] ?? longPath;
      continue;
    }
    if (type === 'L') {
      longPath = td.decode(body).replace(/\0[^]*$/, '');
      continue;
    }
    // Only POSIX ustar ("ustar\0") has a prefix field. The GNU form ("ustar  ") keeps other data there.
    const prefix = text(257, 6) === 'ustar' ? text(345, 155) : '';
    const path = longPath ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    longPath = undefined;
    const top = /^[^/]+\/([^/]+)$/.exec(path)?.[1];
    if ((type === '0' || type === '') && top && !files.has(top)) files.set(top, body);
  }
  return files;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The name, the version and the `npm` fields. A `bin` string becomes an object, as npm does. */
export function readTarball(tgz: Uint8Array): PackedPackage {
  const files = topFiles(tgz);
  const raw = files.get('package.json');
  if (!raw) throw new Error('the tarball has no package.json in its top folder');
  const pkg: unknown = JSON.parse(td.decode(raw));
  if (!isObject(pkg) || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new Error('the package.json of the tarball has no name or no version');
  }
  const npm: Record<string, unknown> = {};
  for (const f of FIELDS) if (pkg[f] !== undefined) npm[f] = pkg[f];
  if (typeof pkg.bin === 'string') npm.bin = { [pkg.name.split('/').at(-1)!]: pkg.bin };
  else if (pkg.bin !== undefined) npm.bin = pkg.bin;
  // npm adds `install: node-gyp rebuild` if binding.gyp exists (and gypfile is not false), and no install script exists.
  const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
  const gyp = files.has('binding.gyp') && pkg.gypfile !== false;
  npm.hasInstallScript = gyp || INSTALL_SCRIPTS.some((s) => Boolean(scripts[s]));
  return { name: pkg.name, version: pkg.version, npm };
}
