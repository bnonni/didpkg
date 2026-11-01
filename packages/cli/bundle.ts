// The Bun.build parts that build.ts (the npm package) and compile.ts (the standalone binaries) share.
// A bundle cannot hold a native addon. The addon loader looks for the addon in the node_modules folder of the build
// machine. Thus the bundle stops with an error on each other machine.
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';

// @did-btcr2/method imports 1 enum (DidVerificationRelationship) from @web5/dids. The index of @web5/dids also loads
// level and the native addon classic-level. This plugin gives @did-btcr2/method only the @web5/dids file with the enum
// (types/did-core.js, which has no imports).
const web5Enum: BunPlugin = {
  name: 'web5-dids-enum',
  setup(build) {
    build.onResolve({ filter: /^@web5\/dids$/ }, ({ importer }) => {
      if (!importer.includes('/node_modules/@did-btcr2/method/')) return undefined;
      return { path: join(dirname(Bun.resolveSync('@web5/dids', dirname(importer))), 'types/did-core.js') };
    });
  },
};

export const PLUGINS = [web5Enum];

// Stops the build if the bundle has a native addon loader.
export function assertNoNativeAddon(metafile: { inputs: Record<string, unknown> }): void {
  const loaders = Object.keys(metafile.inputs).filter((p) => /node_modules\/(node-gyp-build|bindings|prebuild-install)\//.test(p));
  if (loaders.length) throw new Error(`the bundle has a native addon loader, which runs only on the build machine: ${loaders.join(', ')}`);
}
