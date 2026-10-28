// The DWN protocol v1 (ADR 0003 section 6). The spike 06 shape is final.
// This file has no imports, so the reader entry point does not load the DWN SDK.

export const DIDPKG_PROTOCOL = 'https://didpkg.dev/protocols/repository/v1';

/** The protocol definition for `ProtocolsConfigure`. A test checks that it equals the ADR 0003 section 6 JSON. */
export const protocolDefinition = {
  protocol: DIDPKG_PROTOCOL,
  published: true,
  types: {
    package: { schema: 'https://didpkg.dev/schemas/package/v1', dataFormats: ['application/json'] },
    index: { schema: 'https://didpkg.dev/schemas/index/v1', dataFormats: ['application/json'] },
    release: { schema: 'https://didpkg.dev/schemas/release/v1', dataFormats: ['application/json'] },
    tarball: { dataFormats: ['application/gzip'] },
  },
  structure: {
    package: {
      $actions: [{ who: 'anyone', can: ['read'] }],
      $tags: { $requiredTags: ['name'], name: { type: 'string', minLength: 1, maxLength: 64 } },
      $size: { max: 4096 },
      index: { $actions: [{ who: 'anyone', can: ['read'] }], $size: { max: 262144 } },
      release: {
        $immutable: true,
        $actions: [{ who: 'anyone', can: ['read'] }],
        $tags: { $requiredTags: ['version'], version: { type: 'string', maxLength: 256 } },
        $size: { max: 262144 },
        tarball: {
          $immutable: true,
          $actions: [{ who: 'anyone', can: ['read'] }],
          $tags: { $requiredTags: ['version'], version: { type: 'string', maxLength: 256 } },
          $size: { max: 67108864 },
        },
      },
    },
  },
};
