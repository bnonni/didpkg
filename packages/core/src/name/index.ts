// The install-name grammar (docs/spec/install-names.md) and the shim request router.
export { format, formatDirect, parse, didHash, bindHash, GrammarError } from './grammar.ts';
export type { Parsed } from './grammar.ts';
export { route } from './route.ts';
export type { Route } from './route.ts';
