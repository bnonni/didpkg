// The DWN protocols v1 (ADR 0003 section 6) and v2 (ADR 0003 section 9).
// This file has only a type import, so the reader entry point does not load the DWN SDK.
import type { RecordFormat } from '@didpkg/core/source';

export const DIDPKG_PROTOCOL = 'https://didpkg.dev/protocols/repository/v1';
/** v2 adds the Gordian Envelope form of the index and the release. A XID publisher writes v2. A DID publisher writes v1. */
export const DIDPKG_PROTOCOL_V2 = 'https://didpkg.dev/protocols/repository/v2';
/** The media type of a Gordian Envelope (draft-mcnally-envelope). */
export const ENVELOPE_DATA_FORMAT = 'application/envelope+cbor';

/** The protocol of a record form. */
export const protocolOf = (format: RecordFormat = 'json'): string => (format === 'envelope' ? DIDPKG_PROTOCOL_V2 : DIDPKG_PROTOCOL);

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

/** The protocol v2: the structure of v1, and the index and the release also as an Envelope. A test checks it against ADR 0003 section 9. */
export const protocolDefinitionV2 = {
  ...protocolDefinition,
  protocol: DIDPKG_PROTOCOL_V2,
  types: {
    ...protocolDefinition.types,
    index: { schema: 'https://didpkg.dev/schemas/index/v2', dataFormats: ['application/json', ENVELOPE_DATA_FORMAT] },
    release: { schema: 'https://didpkg.dev/schemas/release/v2', dataFormats: ['application/json', ENVELOPE_DATA_FORMAT] },
  },
};

/** The protocol definition of a record form. */
export const definitionOf = (format: RecordFormat = 'json') => (format === 'envelope' ? protocolDefinitionV2 : protocolDefinition);
