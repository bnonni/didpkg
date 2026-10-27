import { TrustError } from '../../src/trust/index.ts';

/** `<code> <reason>` of the TrustError that `run` throws, or `no error`. */
export async function failure(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof TrustError) return `${e.code} ${e.reason}`;
    throw e;
  }
  return 'no error';
}
