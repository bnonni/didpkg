// The static layout v1 (ADR 0003 section 7): <name>/index.json, <name>/<version>.json, <name>/<version>.tgz.
import type { StoredFile } from '@didpkg/core/source';

// Core checks the name and the version before an adapter gets them (ADR 0003 section 5). This check
// also protects a direct caller: a segment cannot be "", "." or "..", and it cannot hold "/" or "\".
const SEGMENT = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function segment(value: string): string {
  if (!SEGMENT.test(value)) throw new TypeError(`not a safe path segment: ${value}`);
  return value;
}

/** The path segments of a file, relative to the repository root. */
export function layoutPath(file: StoredFile): [string, string] {
  const name = segment(file.name);
  if (file.kind === 'index') return [name, 'index.json'];
  return [name, `${segment(file.version)}.${file.kind === 'release' ? 'json' : 'tgz'}`];
}
