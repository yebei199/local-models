// Install this checkout on the current host from its config file: services, gate config, commands.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type HostConfig, modelRoot, type Places, places, read } from './config';
import { type Engine as Name, paths } from './manifest';

/** The checkout every unit and command runs from, so `git pull` plus setup is the whole update. */
const repo = resolve(import.meta.dir, '..');

/** Loopback ports. TTS avoids 8000-8199 because tailnet-https exposes that range; ComfyUI and the
 * web service sit inside it on purpose, so Caddy gives them +10000 HTTPS entries. */
const port = { comfyFront: 8088, comfyBack: 8089, ttsFront: 8290, ttsBack: 8291, engine: 8292 };
const webPort = 8096;

/** Every file setup writes carries this line; anything without it belongs to someone else. */
const MARK = 'Written by local-models setup; edit config.json and run `bun run setup` instead.';

interface Engine {
  command: string[];
  directory: string;
  environment: Record<string, string>;
  vram: number;
}

const script = (name: string) => join(repo, 'engines', name);

type Tts = NonNullable<HostConfig['tts']>;

/** Each engine runs from its installed checkout and venv and answers the Breeze speech contract.
 * Peak VRAM behind the defaults: Breeze eager 8320, Qwen cloning 4487, Ming 2963, tiny int8 11.1 GB. */
function engine(name: Name, models: string, tts: Tts, environment: Record<string, string>): Engine {
  const at = paths(models, name);
  const options = tts.engines[name] ?? {};
  const listen = ['--port', String(port.engine)];
  const withCode = { ...environment, PYTHONPATH: at.code };
  switch (name) {
    case 'breeze':
      return {
        directory: at.code,
        command: [
          at.python,
          '-m',
          'breeze_infer.api',
          at.weights,
          '--host',
          '127.0.0.1',
          ...listen,
        ],
        environment,
        vram: options.requiredVram ?? 9000,
      };
    case 'qwen':
      return {
        directory: at.root,
        command: [at.python, script('qwen.py'), '--model', at.weights, ...listen],
        environment,
        vram: options.requiredVram ?? 6000,
      };
    case 'irodori':
      return {
        directory: at.code,
        command: [
          at.python,
          script('irodori.py'),
          '--checkpoint',
          join(at.weights, 'model.safetensors'),
        ].concat(['--codec', join(at.weights, 'codec.pth')], listen),
        environment: withCode,
        vram: options.requiredVram ?? 6000,
      };
    case 'ming':
      return {
        directory: at.code,
        command: [at.python, script('ming.py'), '--model', at.weights, ...listen],
        environment: withCode,
        vram: options.requiredVram ?? 4500,
      };
    case 'ming-tiny':
      return {
        directory: at.code,
        command: [at.python, script('mingtiny.py'), '--model', at.weights].concat(
          ['--bits', String(options.bits ?? 8)],
          listen,
        ),
        environment: {
          ...environment,
          // tiny pins x-transformers apart from the shared venv, so its own packages go first.
          PYTHONPATH: `${at.packages}:${at.code}`,
          // requiredVram was measured with this allocator setting.
          PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
        },
        vram: options.requiredVram ?? 11500,
      };
  }
}

function engines(tts: Tts, models: string, cuda: string): Record<string, Engine> {
  const environment = {
    LD_LIBRARY_PATH: cuda,
    // NixOS has no /sbin/ldconfig; Triton finds libcuda through this or Qwen's first synthesis fails.
    TRITON_LIBCUDA_PATH: cuda,
    HF_HUB_OFFLINE: '1',
    TOKENIZERS_PARALLELISM: 'false',
  };
  const names = Object.keys(tts.engines) as Name[];
  return Object.fromEntries(names.map((name) => [name, engine(name, models, tts, environment)]));
}

const defaultRoutes = {
  anki: { en: 'breeze', zh: 'breeze', ja: 'irodori' },
  video: { en: 'ming', zh: 'ming-tiny', ja: 'ming' },
};

/** Routes keep only engines this host has, so a host without Irodori still starts its gate. */
function gateConfig(tts: Tts, models: string, cuda: string): string {
  const found = engines(tts, models, cuda);
  const routes = Object.fromEntries(
    Object.entries(tts.routes ?? defaultRoutes).map(([use, byLanguage]) => [
      use,
      Object.fromEntries(Object.entries(byLanguage).filter(([, name]) => name in found)),
    ]),
  );
  const gate = {
    engines: found,
    routes,
    enginePort: port.engine,
    vramWait: 30,
    voices: tts.voices,
  };
  return `${JSON.stringify(gate, null, 1)}\n`;
}

type Section = Record<string, string | number | string[] | undefined>;

function unit(sections: Record<string, Section>): string {
  const lines = [`# ${MARK}`];
  for (const [name, section] of Object.entries(sections)) {
    lines.push(`[${name}]`);
    for (const [key, value] of Object.entries(section)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}=${item}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** A host tool by absolute path, so units keep working when the login PATH differs. The path is a
 * profile link, never resolved into the store: a system upgrade moves the link, and a store path
 * written here would vanish at the next garbage collection while setup has not been rerun. */
function tool(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`setup: ${name} is not on PATH; install it on this host first`);
  return path;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Plan {
  files: Map<string, string>;
  /** Units to enable and start; starting a running unit does nothing. */
  start: string[];
}

function services(config: HostConfig, places: Places, bun: string, plan: Plan): void {
  const serveComfy = config.comfyui?.serve === true;
  if (!config.tts && !serveComfy && !config.web) return;
  const models = modelRoot(config, places);
  const cuda = config.cudaLibraryPath ?? '/run/opengl-driver/lib';
  const idle = config.idleTime ?? '30min';
  const proxyd = resolve(dirname(tool('systemctl')), '../lib/systemd/systemd-socket-proxyd');
  const needs = ['nvidia-smi', 'systemctl', 'ss', ...(config.tts ? ['sox'] : [])];
  if (serveComfy) needs.push('tailscale');
  const path = [...new Set(needs.map((name) => dirname(tool(name))).concat(dirname(bun)))].join(
    ':',
  );
  // bun's fetch follows proxy variables, and a loopback request through a proxy answers 502.
  const env = [`PATH=${path}`, 'NO_PROXY=127.0.0.1,localhost'];
  const run = (entry: string, ...args: string[]) =>
    [bun, join(repo, 'src', entry), '--', ...args].join(' ');
  const at = (name: string) => join(places.units, name);
  /** Idle proxyd exits, the backend follows through StopWhenUnneeded, and its VRAM comes back. */
  const front = (name: string, description: string, back: number) =>
    unit({
      Unit: {
        Description: description,
        Requires: [`${name}.socket`, `${name}-backend.service`],
        After: [`${name}.socket`, `${name}-backend.service`],
      },
      Service: {
        ExecStart: `${proxyd} --exit-idle-time=${idle} 127.0.0.1:${back}`,
        PrivateTmp: 'true',
      },
    });
  const socket = (description: string, listen: number) =>
    unit({
      Unit: { Description: description },
      Socket: { ListenStream: `127.0.0.1:${listen}` },
      Install: { WantedBy: 'sockets.target' },
    });
  /** SIGTERM is how the backends are stopped, so exit 143 is not a failure. */
  const backend = (
    description: string,
    directory: string,
    environment: string[],
    exec: string,
    extra: Section = {},
  ) =>
    unit({
      Unit: { Description: description, StopWhenUnneeded: 'true' },
      Service: {
        Type: 'simple',
        WorkingDirectory: directory,
        Environment: [...env, ...environment],
        ExecStart: exec,
        ExecStartPost: run('backend.ts', 'wait'),
        ...extra,
        TimeoutStopSec: 30,
        SuccessExitStatus: 143,
        Restart: 'no',
      },
    });

  if (serveComfy) {
    plan.files.set(
      at('comfyui.socket'),
      socket('Socket that starts ComfyUI on the first request', port.comfyFront),
    );
    plan.files.set(
      at('comfyui.service'),
      front('comfyui', 'Front for the on-demand ComfyUI backend', port.comfyBack),
    );
    plan.files.set(
      at('comfyui-backend.service'),
      backend(
        'ComfyUI diffusion server',
        paths(models, 'comfyui').code,
        [`PORT=${port.comfyBack}`, `MODELS=${models}`, `CUDA_LIB=${cuda}`],
        run('backend.ts', 'start'),
      ),
    );
    plan.start.push('comfyui.socket');
  }
  if (config.tts) {
    const gate = join(places.state, 'gate.json');
    plan.files.set(gate, gateConfig(config.tts, models, cuda));
    plan.files.set(
      at('tts.socket'),
      socket('Socket that starts the speech gate on the first request', port.ttsFront),
    );
    plan.files.set(
      at('tts.service'),
      front('tts', 'Front for the on-demand speech gate', port.ttsBack),
    );
    plan.files.set(
      at('tts-backend.service'),
      backend(
        'Speech gate that runs one model at a time',
        models,
        [`PORT=${port.ttsBack}`, `GATE_CONFIG=${gate}`],
        run('gate.ts'),
        { TimeoutStartSec: 300 },
      ),
    );
    plan.start.push('tts.socket');
  }
  if (config.web) {
    plan.files.set(
      at('local-models-web.service'),
      unit({
        Unit: { Description: 'Audition pages for the tailnet' },
        Service: {
          Type: 'simple',
          Environment: [
            ...env,
            `PORT=${webPort}`,
            `WEB_DIR=${config.web.directory ?? places.web}`,
            `WEB_UI=${join(repo, 'web/dist')}`,
          ],
          ExecStart: run('web.ts'),
          SuccessExitStatus: 143,
          Restart: 'on-failure',
        },
        Install: { WantedBy: 'default.target' },
      }),
    );
    plan.start.push('local-models-web.service');
  }
}

/** The user's commands; `${X-default}` keeps an explicitly empty TTS_HOST meaning "this machine". */
function commands(config: HostConfig, places: Places, bun: string, plan: Plan): void {
  const defaults: Record<string, string | undefined> = {
    TTS_HOST: config.host ?? '',
    TTS_PORT: String(port.ttsFront),
    COMFYUI_URL: config.comfyui?.url,
  };
  const exports = Object.entries(defaults)
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) => `export ${name}="\${${name}-${(value as string).replaceAll('"', '\\"')}}"`,
    );
  const entries: [string, string, string][] = [
    ['tts', 'tts.ts', ''],
    ['scene-image', 'scene.ts', 'image'],
    ['scene-video', 'scene.ts', 'video'],
    ['scene-narrate', 'narrate.ts', ''],
    ['scene-show', 'show.ts', ''],
  ];
  for (const [name, entry, mode] of entries) {
    // The `--` after the entry is required: bun would otherwise swallow the script's first `--`.
    const exec = [quote(bun), quote(join(repo, 'src', entry)), '--', mode, '"$@"'].filter(Boolean);
    plan.files.set(
      join(places.bin, name),
      [
        '#!/bin/sh',
        `# ${MARK}`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion, not a template
        'export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"',
        ...exports,
        `exec ${exec.join(' ')}`,
        '',
      ].join('\n'),
    );
  }
}

/** Refuse to replace a file setup did not write, such as a unit Home Manager still links. The
 * state directory belongs to setup alone, so its files need no mark. */
function writable(path: string, state: string): boolean {
  if (!existsSync(path) || path.startsWith(`${state}/`)) return true;
  return readFileSync(path, 'utf8').includes(MARK);
}

function systemctl(...args: string[]): void {
  const result = Bun.spawnSync(['systemctl', '--user', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`systemctl --user ${args.join(' ')} failed`);
}

const active = (name: string) =>
  Bun.spawnSync(['systemctl', '--user', '--quiet', 'is-active', name]).exitCode === 0;

/** Write what differs and name the files that existed with other content. */
function write(plan: Plan, state: string): string[] {
  const foreign = [...plan.files.keys()].filter((path) => !writable(path, state));
  if (foreign.length)
    throw new Error(`setup: not written by setup, move away first:\n  ${foreign.join('\n  ')}`);
  const changed: string[] = [];
  for (const [path, content] of plan.files) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (before === content) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: path.includes('/bin/') ? 0o755 : 0o644 });
    if (before !== null) changed.push(path.split('/').at(-1) as string);
  }
  return changed;
}

/** Never restart or stop a model unit: a restart drops the job running on the GPU. Only the web
 * service is restarted, since it holds no VRAM and runs no jobs. */
function apply(plan: Plan, state: string): void {
  const changed = write(plan, state);
  systemctl('daemon-reload');
  if (plan.start.length) systemctl('enable', '--now', ...plan.start);
  const web = 'local-models-web.service';
  if (plan.start.includes(web)) systemctl('restart', web);
  for (const name of changed)
    if (name !== web && active(name))
      console.log(`setup: ${name} changed and still runs the old definition; restart it when idle`);
}

if (import.meta.main) {
  try {
    const where = places();
    const config = read(where.config);
    const bun = tool('bun');
    const plan: Plan = { files: new Map(), start: [] };
    services(config, where, bun, plan);
    commands(config, where, bun, plan);
    apply(plan, where.state);
    console.log(
      `setup: ${plan.files.size} files in place, started ${plan.start.join(', ') || 'nothing'}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
