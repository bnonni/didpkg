import { expect, test } from 'bun:test';
import { DID_ERROR_NS, errorCode, failure, fromLibraryError, fromLibraryResult, problem } from '../../src/did/errors.ts';

const codeOf = (raw: unknown) => fromLibraryResult(raw).didResolutionMetadata.error?.type;

test('problem() and failure() give RFC 9457 objects with W3C type URLs', () => {
  expect(problem('NOT_FOUND')).toEqual({ type: 'https://www.w3.org/ns/did#NOT_FOUND', title: 'NOT_FOUND' });
  expect(failure('INVALID_DID', 'bad', { transient: false })).toEqual({
    didResolutionMetadata: { transient: false, error: { type: DID_ERROR_NS + 'INVALID_DID', title: 'INVALID_DID', detail: 'bad' } },
    didDocument: null,
    didDocumentMetadata: {},
  });
});

test('style 1: legacy camelCase codes map to W3C codes', () => {
  expect(codeOf({ didResolutionMetadata: { error: 'notFound', message: 'gone' } })).toBe(DID_ERROR_NS + 'NOT_FOUND');
  expect(codeOf({ didResolutionMetadata: { error: 'invalidDid' } })).toBe(DID_ERROR_NS + 'INVALID_DID');
  expect(codeOf({ didResolutionMetadata: { error: 'invalidPublicKeyLength' } })).toBe(DID_ERROR_NS + 'INVALID_DID');
  expect(codeOf({ didResolutionMetadata: { error: 'invalidSignature' } })).toBe(DID_ERROR_NS + 'INVALID_DID_DOCUMENT');
  expect(codeOf({ didResolutionMetadata: { error: 'methodNotSupported' } })).toBe(DID_ERROR_NS + 'METHOD_NOT_SUPPORTED');
  expect(codeOf({ didResolutionMetadata: { error: 'resolutionError' } })).toBe(DID_ERROR_NS + 'INTERNAL_ERROR');
  expect(codeOf({ didResolutionMetadata: { error: 'somethingNew' } })).toBe(DID_ERROR_NS + 'INTERNAL_ERROR');
});

test('style 2 and 3: W3C code strings and RFC 9457 objects', () => {
  expect(codeOf({ didResolutionMetadata: { error: 'FEATURE_NOT_SUPPORTED' } })).toBe(DID_ERROR_NS + 'FEATURE_NOT_SUPPORTED');
  const r = fromLibraryResult({ didResolutionMetadata: { error: { type: DID_ERROR_NS + 'INVALID_OPTIONS', detail: 'both' } } });
  expect(r.didResolutionMetadata.error).toEqual({ type: DID_ERROR_NS + 'INVALID_OPTIONS', title: 'INVALID_OPTIONS', detail: 'both' });
  expect(codeOf({ didResolutionMetadata: { error: { type: 'https://example.com/other' } } })).toBe(DID_ERROR_NS + 'INTERNAL_ERROR');
});

test('the detail comes from errorMessage, message or the problem detail', () => {
  const detail = (raw: unknown) => fromLibraryResult(raw).didResolutionMetadata.error?.detail;
  expect(detail({ didResolutionMetadata: { error: 'invalidDid', errorMessage: 'enbox text' } })).toBe('enbox text');
  expect(detail({ didResolutionMetadata: { error: 'notFound', message: 'web text' } })).toBe('web text');
  expect(detail({ didResolutionMetadata: { error: 'notFound' } })).toBe('notFound');
});

test('a success keeps the document and drops library metadata', () => {
  const r = fromLibraryResult({ didResolutionMetadata: { contentType: 'x' }, didDocument: { id: 'did:x:1' }, didDocumentMetadata: { versionId: '2' } });
  expect(r).toEqual({ didResolutionMetadata: {}, didDocument: { id: 'did:x:1' }, didDocumentMetadata: { versionId: '2' } });
  expect(fromLibraryResult(undefined)).toEqual({ didResolutionMetadata: {}, didDocument: null, didDocumentMetadata: {} });
});

test('fromLibraryError maps a thrown error with a camelCase code', () => {
  const e = Object.assign(new Error('Invalid signature'), { code: 'invalidSignature' });
  expect(fromLibraryError(e).didResolutionMetadata.error?.type).toBe(DID_ERROR_NS + 'INVALID_DID_DOCUMENT');
  expect(fromLibraryError(new Error('boom')).didResolutionMetadata.error).toEqual(problem('INTERNAL_ERROR', 'boom'));
  expect(fromLibraryError('text').didResolutionMetadata.error?.detail).toBe('text');
});

test('errorCode reads the code of a result', () => {
  expect(errorCode(failure('NOT_FOUND'))).toBe('NOT_FOUND');
  expect(errorCode({ didResolutionMetadata: {}, didDocument: null, didDocumentMetadata: {} })).toBeUndefined();
  expect(errorCode({ didResolutionMetadata: { error: { type: 'x' } }, didDocument: null, didDocumentMetadata: {} })).toBe('INTERNAL_ERROR');
});
