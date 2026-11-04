// The static layout v1 (ADR 0003 section 7): <name>/index.json, <name>/<version>.json, <name>/<version>.tgz.
// A XID publisher signs Gordian Envelopes: <name>/index.envelope, <name>/<version>.envelope, and its
// XID document at xid/<hex>.envelope (docs/spec/release-records.md section 6).
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
  if (file.kind === 'tarball') return [name, `${segment(file.version)}.tgz`];
  const ext = file.format === 'envelope' ? 'envelope' : 'json';
  return [name, `${file.kind === 'index' ? 'index' : segment(file.version)}.${ext}`];
}

/** The path segments of a XID document, relative to the repository root. The XID is 64 lowercase hex characters. */
export function xidDocumentPath(xid: string): [string, string] {
  if (!/^[0-9a-f]{64}$/.test(xid)) throw new TypeError(`not a XID: ${xid}`);
  return ['xid', `${xid}.envelope`];
}
