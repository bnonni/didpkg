// A passphrase from an environment variable (CI), else from the terminal with no echo.
export const MIN_PASSPHRASE = 12;

/** One line from the terminal in raw mode, with no echo. Ctrl-C and Ctrl-D stop the read. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003' || ch === '\u0004') return done(new Error('stopped'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** `confirm`: ask two times and require one length minimum (for a new key). */
export async function passphrase(o: { env: string; prompt: string; confirm?: boolean }): Promise<string> {
  const fromEnv = process.env[o.env];
  let value: string;
  if (fromEnv) {
    value = fromEnv;
  } else if (process.stdin.isTTY) {
    value = await readHidden(`${o.prompt}: `);
    if (o.confirm && (await readHidden(`${o.prompt} (again): `)) !== value) throw new Error('the passphrases are not the same');
  } else {
    throw new Error(`no passphrase: set ${o.env}, or run in a terminal`);
  }
  if (o.confirm && value.length < MIN_PASSPHRASE) throw new Error(`${o.env}: use ${MIN_PASSPHRASE} or more characters`);
  return value;
}
