// The config file `<config>/config.json`. Each key is optional. A key has the name of the flag that replaces it.
//   cas      IPFS Trustless Gateway base URLs, in order, for the did:btcr2 data. `--cas` replaces the list. An empty list turns CAS off.
//   dwn      DWN base URLs for a did:key or did:jwk publisher. Its DID document cannot have a service. `--dwn` replaces the list.
//   esplora  The Esplora API base URL for each Bitcoin network of did:btcr2, for example {"testnet4": "https://..."}.
//   sidecar  Mirror base URLs, in order, for the did:btcr2 Sidecar Data. `--sidecar` replaces the list.
//   xid-resolver  XID resolver base URLs. The document of a XID is at `<url>/xid/<hex>.envelope`. `--xid-resolver` replaces the list.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Btcr2DriverOptions } from '@didpkg/core/did/btcr2';
import { endpoint } from './id/dht.ts';
import { configDir } from './id/store.ts';

type Esplora = NonNullable<Btcr2DriverOptions['esplora']>;

export interface Config {
  cas?: string[];
  dwn?: string[];
  esplora?: Esplora;
  sidecar?: string[];
  'xid-resolver'?: string[];
}

const NETWORKS: Readonly<Record<keyof Esplora, true>> = { bitcoin: true, testnet3: true, testnet4: true, signet: true, mutinynet: true, regtest: true };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function configFile(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), 'config.json');
}

/** No file gives an empty config. An unknown key or a bad value is an error. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const file = configFile(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(v)) throw new Error(`${file}: the file must be a JSON object`);
  const config: Config = {};
  for (const [key, value] of Object.entries(v)) {
    if (key === 'cas' || key === 'dwn' || key === 'sidecar' || key === 'xid-resolver') {
      if (!Array.isArray(value) || !value.every((u) => typeof u === 'string')) throw new Error(`${file}: "${key}" must be a list of URLs`);
      config[key] = value.map((u) => endpoint(u, `${file}: ${key}`));
    } else if (key === 'esplora') {
      if (!isObject(value)) throw new Error(`${file}: "esplora" must be an object with a URL for each network`);
      const esplora: Esplora = {};
      for (const [network, url] of Object.entries(value)) {
        if (!Object.hasOwn(NETWORKS, network)) {
          throw new Error(`${file}: esplora: ${JSON.stringify(network)} is not a network (use ${Object.keys(NETWORKS).join(', ')})`);
        }
        if (typeof url !== 'string') throw new Error(`${file}: esplora: the value of ${network} must be a URL`);
        esplora[network as keyof Esplora] = endpoint(url, `${file}: esplora: ${network}`);
      }
      config.esplora = esplora;
    } else {
      throw new Error(`${file}: unknown key ${JSON.stringify(key)} (use cas, dwn, esplora, sidecar, xid-resolver)`);
    }
  }
  return config;
}
