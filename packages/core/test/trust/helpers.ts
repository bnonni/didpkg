import { PolicyError, TrustError } from '../../src/trust/index.ts';

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

/** The code of the PolicyError that `run` throws, or `ok`. */
export async function outcome(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof PolicyError) return e.code;
    throw e;
  }
  return 'ok';
}
