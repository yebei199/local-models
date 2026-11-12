// The host's config.json and the places derived from it, shared by install and setup.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Engine, engineNames, type Name } from './manifest';

export interface Voice {
  path: string;
  text: string;
}

export interface EngineConfig {
  requiredVram?: number;
  /** ming-tiny only: expert weights quantized to 4 or 8 bits on load. */
  bits?: 4 | 8;
}

/** The host's own values; nothing here is checked into the repo. */
export interface HostConfig {
  /** Model host for the commands; empty or this machine's name means local. */
  host?: string;
  /** Install root for model code, environments and weights. */
  models?: string;
  idleTime?: string;
  cudaLibraryPath?: string;
  comfyui?: { url?: string; serve?: boolean };
  web?: { directory?: string };
  /** `url` is the tailnet entry the `translate` command calls; `serve` runs the model here. */
  translate?: { url?: string; serve?: boolean; requiredVram?: number };
  tts?: {
    voices: Record<string, Record<string, Voice>>;
    routes?: Record<string, Record<string, string>>;
    engines: Partial<Record<Engine, EngineConfig>>;
  };
}

export interface Places {
  config: string;
  state: string;
  units: string;
  bin: string;
  web: string;
  models: string;
}

export function places(): Places {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is not set');
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const data = process.env.XDG_DATA_HOME || join(home, '.local/share');
  return {
    config: process.env.LOCAL_MODELS_CONFIG || join(config, 'local-models/config.json'),
    state: join(process.env.XDG_STATE_HOME || join(home, '.local/state'), 'local-models'),
    units: join(config, 'systemd/user'),
    bin: join(home, '.local/bin'),
    web: join(data, 'local-models/web'),
    models: join(data, 'local-models/models'),
  };
}

/** Keys from the layout before installs moved into this repo; naming them beats ignoring them. */
const retired = [
  'comfyui.directory',
  'tts.directory',
  'tts.modelDirectory',
  'tts.requiredVram',
  'tts.qwen',
  'tts.irodori',
  'tts.ming',
  'tts.mingTiny',
];

function lookup(config: object, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (at, key) =>
        at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined,
      config,
    );
}

/** Shape errors fail here by name, not later as a unit that cannot start. */
export function read(path: string): HostConfig {
  if (!existsSync(path)) throw new Error(`write ${path} first (see README)`);
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || typeof config !== 'object') throw new Error('config.json: not an object');
  const stale = retired.filter((key) => lookup(config, key) !== undefined);
  if (stale.length)
    throw new Error(
      `config.json: ${stale.join(', ')} no longer exist; installs live under "models" (see README)`,
    );
  const tts = (config as HostConfig).tts;
  if (tts) {
    if (typeof tts.voices !== 'object') throw new Error('config.json: tts.voices is required');
    const names = Object.keys(tts.engines ?? {});
    if (!names.length) throw new Error('config.json: tts.engines must name at least one engine');
    const unknown = names.filter((name) => !(engineNames as readonly string[]).includes(name));
    if (unknown.length) throw new Error(`config.json: unknown engines ${unknown.join(', ')}`);
  }
  return config as HostConfig;
}

/** The components this host serves, which is what install fetches and setup runs. */
export function served(config: HostConfig): Name[] {
  const engines = Object.keys(config.tts?.engines ?? {}) as Engine[];
  return [
    ...(config.comfyui?.serve ? (['comfyui'] as const) : []),
    ...engines,
    ...(config.translate?.serve ? (['translator'] as const) : []),
  ];
}

export const modelRoot = (config: HostConfig, where: Places) => config.models ?? where.models;
