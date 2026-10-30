// Shim request router for the didpkg npm shim. Framework-free and pure.
// Rules that stop the drpm.tools bug from coming back:
//  1. No framework path patterns for names. The server gives (method, raw path); this function does the rest.
//  2. One decode step only: the scope slash "%2f" or "%2F". Any other "%" is a 400. No decodeURIComponent.
//  3. The name goes through grammar.parse(), which checks format(parse(x)) === x (canonical, lossless).
//  4. A tarball file name must equal "<body>-<semver>.tgz" for the same body. The shim makes these URLs itself.
import { parse, SCOPE, type Parsed } from './grammar.ts';

export type Route =
  | { kind: 'packument'; name: string; parsed: Parsed }
  | { kind: 'tarball'; name: string; parsed: Parsed; version: string }
  | { kind: 'publish'; name: string; parsed: Parsed }
  | { kind: 'reject'; status: 400 | 404 | 405; reason: string };

// semver 2.0.0, section 9-10 characters only; the full check happens later with a semver library.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/;
const PATH_CHARS = /^[A-Za-z0-9@/%._+-]+$/;

export function route(method: string, rawPath: string): Route {
  const qs = rawPath.indexOf('?');
  const path = qs < 0 ? rawPath : rawPath.slice(0, qs); // the query is never part of the name
  if (!PATH_CHARS.test(path)) return { kind: 'reject', status: 400, reason: 'bad character in path' };
  const scopeRe = new RegExp(`^/${SCOPE}(?:/|%2[fF])([^/%]+)(?:/-/([^/%]+))?$`);
  const m = scopeRe.exec(path);
  if (!m) return { kind: 'reject', status: 404, reason: path.includes('%') ? 'unexpected percent escape' : 'not a didpkg path' };
  const body = m[1];
  const file = m[2];
  const name = `${SCOPE}/${body}`;
  let parsed: Parsed;
  try { parsed = parse(name); } catch (e) { return { kind: 'reject', status: 400, reason: (e as Error).message }; }
  if (file === undefined) {
    if (method === 'GET' || method === 'HEAD') return { kind: 'packument', name, parsed };
    if (method === 'PUT') return { kind: 'publish', name, parsed };
    return { kind: 'reject', status: 405, reason: 'method not allowed' };
  }
  if (method !== 'GET' && method !== 'HEAD') return { kind: 'reject', status: 405, reason: 'method not allowed' };
  const prefix = `${body}-`;
  if (!file.startsWith(prefix) || !file.endsWith('.tgz')) return { kind: 'reject', status: 404, reason: 'tarball file does not match the name' };
  const version = file.slice(prefix.length, -'.tgz'.length);
  if (!SEMVER.test(version)) return { kind: 'reject', status: 404, reason: 'bad version in tarball file' };
  return { kind: 'tarball', name, parsed, version };
}
